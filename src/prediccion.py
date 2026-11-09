"""Predicción del consumo mensual de energía activa (kWh) de los usuarios especiales.

Flujo
-----
1. ``datos_modelado``     serie mensual global (solo meses completos) y variables de calendario.
2. ``validar``            validación temporal con origen móvil: se entrena con los datos hasta cada origen y se
                          pronostican los 12 meses siguientes, sin usar información del futuro.
3. ``comparar``           MAE, RMSE, MAPE, WAPE, R², sesgo y MASE por modelo; el mejor es el de menor MAPE en la
                          validación cruzada (el último origen = prueba final de 12 meses).
4. ``pronostico_final``   el mejor modelo se reentrena con toda la serie y pronostica hasta el mes objetivo, con
                          intervalos empíricos del 80 % y 95 % construidos con los errores de la validación.
5. ``nivel_entidades``    selección de modelo por usuario y por cuenta (prueba de 12 meses en cada serie).
6. ``exportar_resultados`` predicciones.xlsx, indicadores.xlsx, modelo persistido y static/js/data.js.

Uso desde la raíz del proyecto:  ``python -m src.prediccion``
Compatible con Python 3.9+ (pandas 2.x, scikit-learn ≥ 1.3, scipy).
"""
from __future__ import annotations

import time
import warnings
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV, TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import procesamiento as pr
from . import utils

warnings.filterwarnings('ignore', category=UserWarning)

ESTACION = 12
HORIZONTE_VALIDACION = 12
MES_OBJETIVO = '2027-12'                 # último mes a pronosticar
SEMILLA = 42
LAGS = (1, 2, 3, 12)

CATALOGO = {
    'Naive estacional': 'Repite el valor del mismo mes del año anterior. Referencia mínima que cualquier modelo debe superar.',
    'Promedio móvil 12 m': 'Proyecta plano el promedio de los últimos 12 meses. Referencia de nivel sin estacionalidad.',
    'Holt-Winters': 'Suavizamiento exponencial con nivel, tendencia amortiguada y estacionalidad aditiva (parámetros por máxima verosimilitud aproximada: mínimo error de un paso).',
    'Regresión estacional': 'Ridge con tendencia lineal, un indicador por mes y días hábiles del mes.',
    'Ridge con rezagos': 'Ridge sobre los consumos de 1, 2, 3 y 12 meses antes, estacionalidad (seno/coseno), tendencia y días hábiles; pronóstico recursivo.',
    'Random Forest': 'Bosque aleatorio con las mismas variables de rezagos y calendario; pronóstico recursivo.',
    'Gradient Boosting': 'Gradient boosting por histogramas con las mismas variables; pronóstico recursivo.',
}
MODELOS = list(CATALOGO)


# ==========================================================================================================
# Modelos
# ==========================================================================================================
class Modelo:
    """Interfaz común: ``ajustar(y)`` con una serie mensual (DatetimeIndex) y ``pronosticar(h)``."""
    nombre = ''
    min_obs = ESTACION

    def __init__(self, cal: pd.DataFrame, tunear: bool = False):
        self.cal, self.tunear, self.params = cal, tunear, {}

    def ajustar(self, y: pd.Series) -> 'Modelo':
        self.y_ = y.astype(float)
        self.fin_ = y.index[-1]
        return self

    def fechas_futuras(self, h: int) -> pd.DatetimeIndex:
        return pd.date_range(self.fin_ + pd.offsets.MonthBegin(1), periods=h, freq='MS')

    def pronosticar(self, h: int) -> np.ndarray:  # pragma: no cover - interfaz
        raise NotImplementedError


class NaiveEstacional(Modelo):
    nombre = 'Naive estacional'

    def pronosticar(self, h):
        ult = self.y_.values[-ESTACION:]
        return np.array([ult[i % ESTACION] for i in range(h)])


class PromedioMovil(Modelo):
    nombre, min_obs = 'Promedio móvil 12 m', 1

    def pronosticar(self, h):
        return np.full(h, self.y_.values[-ESTACION:].mean())


class HoltWinters(Modelo):
    """Holt-Winters aditivo con tendencia amortiguada, implementado con scipy (no requiere statsmodels)."""
    nombre, min_obs = 'Holt-Winters', 2 * ESTACION

    @staticmethod
    def _filtrar(y, a, b, g, phi, m=ESTACION):
        l0 = y[:m].mean()
        b0 = (y[m:2 * m].mean() - y[:m].mean()) / m
        s = list(y[:m] - l0)
        l, t, sse = l0, b0, 0.0
        for i, yi in enumerate(y):
            si = s[i]
            f = l + phi * t + si
            sse += (yi - f) ** 2
            l_new = a * (yi - si) + (1 - a) * (l + phi * t)
            t = b * (l_new - l) + (1 - b) * phi * t
            s.append(g * (yi - l_new) + (1 - g) * si)
            l = l_new
        return sse, l, t, s[-m:]

    def ajustar(self, y):
        super().ajustar(y)
        v = self.y_.values
        escala = max(v.mean(), 1.0)
        z = v / escala
        mejor = None
        for x0 in ([0.3, 0.05, 0.1, 0.95], [0.6, 0.1, 0.3, 0.9], [0.1, 0.01, 0.05, 0.98]):
            r = minimize(lambda p: self._filtrar(z, *p)[0], x0, method='L-BFGS-B',
                         bounds=[(0.01, 0.99), (0.0, 0.5), (0.0, 0.99), (0.8, 0.99)])
            if mejor is None or r.fun < mejor.fun:
                mejor = r
        a, b, g, phi = mejor.x
        _, l, t, s = self._filtrar(z, a, b, g, phi)
        self.estado_ = (l * escala, t * escala, np.array(s) * escala, phi)
        self.params = {k: round(float(v), 3) for k, v in zip(('alpha', 'beta', 'gamma', 'phi'), (a, b, g, phi))}
        return self

    def pronosticar(self, h):
        l, t, s, phi = self.estado_
        amort = np.cumsum(phi ** np.arange(1, h + 1))
        return np.array([l + amort[k] * t + s[k % ESTACION] for k in range(h)])


class RegresionEstacional(Modelo):
    nombre, min_obs = 'Regresión estacional', 2 * ESTACION

    def _X(self, fechas):
        t = np.array([(f.year - self.inicio_.year) * 12 + f.month - self.inicio_.month for f in fechas], float)
        meses = np.array([f.month for f in fechas])
        dummies = np.stack([(meses == m).astype(float) for m in range(2, 13)], axis=1)
        hab = self.cal.reindex(fechas)['DIAS_HABILES'].values.astype(float)[:, None]
        return np.hstack([t[:, None], dummies, hab])

    def ajustar(self, y):
        super().ajustar(y)
        self.inicio_ = y.index[0]
        X = self._X(y.index)
        est = make_pipeline(StandardScaler(), Ridge(alpha=1.0))
        if self.tunear and len(y) >= 36:
            gs = GridSearchCV(est, {'ridge__alpha': [0.1, 1, 10, 100]}, cv=TimeSeriesSplit(3), scoring='neg_mean_absolute_error')
            gs.fit(X, self.y_.values)
            est, self.params = gs.best_estimator_, {'alpha': float(gs.best_params_['ridge__alpha'])}
        else:
            est.fit(X, self.y_.values)
            self.params = {'alpha': 1.0}
        self.est_ = est
        return self

    def pronosticar(self, h):
        return self.est_.predict(self._X(self.fechas_futuras(h)))


class ModeloRezagos(Modelo):
    """Modelo de aprendizaje automático sobre rezagos + calendario, con pronóstico recursivo."""
    min_obs = 3 * ESTACION

    def __init__(self, cal, tunear=False, nombre='', estimador=None, grilla=None):
        super().__init__(cal, tunear)
        self.nombre, self.estimador, self.grilla = nombre, estimador, grilla or {}

    def _fila(self, hist, fecha, t):
        hab = float(self.cal.at[fecha, 'DIAS_HABILES'])
        ang = 2 * np.pi * fecha.month / 12
        return [hist[-l] for l in LAGS] + [np.sin(ang), np.cos(ang), t, hab]

    def ajustar(self, y):
        super().ajustar(y)
        v = list(self.y_.values)
        X = [self._fila(v[:i], f, i) for i, f in enumerate(y.index) if i >= max(LAGS)]
        Y = v[max(LAGS):]
        est = self.estimador
        if self.tunear and self.grilla:
            gs = GridSearchCV(est, self.grilla, cv=TimeSeriesSplit(3), scoring='neg_mean_absolute_error')
            gs.fit(X, Y)
            est = gs.best_estimator_
            self.params = {k.split('__')[-1]: (float(v) if isinstance(v, float) else v) for k, v in gs.best_params_.items()}
        else:
            est.fit(X, Y)
        self.est_ = est
        return self

    def pronosticar(self, h):
        hist, out, n = list(self.y_.values), [], len(self.y_)
        for k, f in enumerate(self.fechas_futuras(h)):
            v = max(0.0, float(self.est_.predict([self._fila(hist, f, n + k)])[0]))
            out.append(v)
            hist.append(v)
        return np.array(out)


def crear_modelo(nombre: str, cal: pd.DataFrame, tunear: bool = False, ligero: bool = False) -> Modelo:
    """Fábrica de modelos. ``tunear`` activa GridSearchCV con TimeSeriesSplit; ``ligero`` reduce árboles (nivel entidad)."""
    if nombre == 'Naive estacional':
        return NaiveEstacional(cal)
    if nombre == 'Promedio móvil 12 m':
        return PromedioMovil(cal)
    if nombre == 'Holt-Winters':
        return HoltWinters(cal)
    if nombre == 'Regresión estacional':
        return RegresionEstacional(cal, tunear)
    if nombre == 'Ridge con rezagos':
        return ModeloRezagos(cal, tunear, nombre, make_pipeline(StandardScaler(), Ridge(alpha=10.0)),
                             {'ridge__alpha': [0.1, 1, 10, 100]})
    if nombre == 'Random Forest':
        return ModeloRezagos(cal, tunear, nombre,
                             RandomForestRegressor(n_estimators=80 if ligero else 300, min_samples_leaf=2,
                                                   random_state=SEMILLA, n_jobs=1 if ligero else -1),
                             {'max_depth': [3, 5, None], 'min_samples_leaf': [1, 3]})
    if nombre == 'Gradient Boosting':
        return ModeloRezagos(cal, tunear, nombre,
                             HistGradientBoostingRegressor(max_iter=150, learning_rate=0.05, max_leaf_nodes=7,
                                                           min_samples_leaf=5, random_state=SEMILLA),
                             {'learning_rate': [0.03, 0.1], 'max_leaf_nodes': [5, 15], 'min_samples_leaf': [5, 10]})
    raise ValueError(f'Modelo desconocido: {nombre}')


def escala_mase(v) -> float:
    """MAE del naive estacional dentro de la muestra (denominador del MASE)."""
    v = np.asarray(v, float)
    return float(np.mean(np.abs(v[ESTACION:] - v[:-ESTACION]))) if len(v) > ESTACION else np.nan


# ==========================================================================================================
# Datos
# ==========================================================================================================
def datos_modelado(base: pr.Base, hasta: str = MES_OBJETIVO):
    """Serie global y calendario que cubre la historia y el horizonte de pronóstico."""
    utils.crear_carpetas()
    serie = base.serie_global
    if not utils.RUTA_VARIABLES.exists():
        pr.escribir_variables_externas(serie.index[0].strftime('%Y-%m-%d'), f'{hasta}-01')
    cal = pr.leer_variables_externas()
    faltan = pd.date_range(serie.index[0], f'{hasta}-01', freq='MS').difference(cal.index)
    if len(faltan):
        raise ValueError(f'variables_externas.csv no cubre {len(faltan)} meses (p. ej. {faltan[0]:%Y-%m}).')
    return serie, cal


# ==========================================================================================================
# Validación temporal (origen móvil)
# ==========================================================================================================
def origenes_validacion(n: int, n_origenes: int = 5, paso: int = 3, h: int = HORIZONTE_VALIDACION) -> list:
    """Longitudes de entrenamiento: el último origen deja exactamente ``h`` meses de prueba."""
    return [n - h - paso * k for k in reversed(range(n_origenes))]


def validar(serie: pd.Series, cal: pd.DataFrame, modelos=None, origenes=None, h: int = HORIZONTE_VALIDACION,
            tunear: bool = True, verbose: bool = True):
    """Devuelve (predicciones de validación en formato largo, hiperparámetros por modelo y origen)."""
    modelos = modelos or MODELOS
    origenes = origenes or origenes_validacion(len(serie))
    filas, hiper = [], []
    for n_tr in origenes:
        train, test = serie.iloc[:n_tr], serie.iloc[n_tr:n_tr + h]
        escala = escala_mase(train.values)
        for nombre in modelos:
            m = crear_modelo(nombre, cal, tunear)
            if len(train) < m.min_obs:
                continue
            t0 = time.time()
            m.ajustar(train)
            pred = m.pronosticar(len(test))
            hiper.append({'Modelo': nombre, 'Origen': train.index[-1], 'Parámetros': str(m.params),
                          'Segundos': round(time.time() - t0, 2)})
            for k, (f, real, p) in enumerate(zip(test.index, test.values, pred), start=1):
                filas.append({'Modelo': nombre, 'Origen': train.index[-1], 'H': k, 'FECHA': f, 'Real': real,
                              'Pronóstico': float(p), 'Escala_MASE': escala})
        if verbose:
            print(f'  origen {train.index[-1]:%Y-%m}: {len(modelos)} modelos evaluados')
    bt = pd.DataFrame(filas)
    bt['Error'] = bt['Pronóstico'] - bt['Real']
    bt['Error_%'] = bt['Error'] / bt['Real'] * 100
    return bt, pd.DataFrame(hiper)


def comparar(bt: pd.DataFrame, criterio: str = 'MAPE_%') -> dict:
    """Métricas por modelo en la validación cruzada (todos los orígenes) y en la prueba final (último origen)."""
    def tabla(d):
        filas = []
        for nombre, g in d.groupby('Modelo'):
            m = utils.metricas(g['Real'], g['Pronóstico'])
            m['MASE'] = float(np.mean(np.abs(g['Error']) / g['Escala_MASE']))
            filas.append({'Modelo': nombre, **m})
        t = pd.DataFrame(filas).set_index('Modelo').sort_values(criterio)
        if 'Naive estacional' in t.index:
            t['Mejora_vs_naive_%'] = (1 - t['MAE'] / t.at['Naive estacional', 'MAE']) * 100
        t['Ranking'] = range(1, len(t) + 1)
        return t
    ultimo = bt['Origen'].max()
    cv, prueba = tabla(bt), tabla(bt[bt['Origen'] == ultimo])
    por_h = bt.assign(APE=lambda d: d['Error_%'].abs()).pivot_table(index='H', columns='Modelo', values='APE', aggfunc='mean')
    por_origen = (bt.groupby(['Modelo', 'Origen']).apply(lambda g: utils.metricas(g['Real'], g['Pronóstico'])['MAPE_%'])
                  .unstack('Origen'))
    return {'cv': cv, 'prueba': prueba, 'por_h': por_h[cv.index], 'por_origen': por_origen.loc[cv.index],
            'mejor': cv.index[0], 'criterio': criterio, 'origen_prueba': ultimo}


# ==========================================================================================================
# Pronóstico final con intervalos empíricos
# ==========================================================================================================
def pronostico_final(serie: pd.Series, cal: pd.DataFrame, modelo: str, bt: pd.DataFrame, hasta: str = MES_OBJETIVO,
                     tunear: bool = True):
    """Reentrena ``modelo`` con toda la serie y pronostica hasta ``hasta`` con intervalos del 80 % y 95 %.

    Los intervalos son simétricos alrededor del pronóstico: ± el percentil 80, 90 y 95 del error relativo absoluto
    |real − pronóstico| / pronóstico que tuvo ese modelo en la validación, agrupado por horizonte (1–3, 4–6 y
    7–12 meses). Para horizontes mayores a 12 meses se amplían en proporción a √(h/12).
    """
    fin = pd.Timestamp(f'{hasta}-01')
    h = (fin.year - serie.index[-1].year) * 12 + fin.month - serie.index[-1].month
    m = crear_modelo(modelo, cal, tunear).ajustar(serie)
    pred = m.pronosticar(h)
    fechas = m.fechas_futuras(h)
    err = bt[bt['Modelo'] == modelo].assign(R=lambda d: ((d['Real'] - d['Pronóstico']) / d['Pronóstico']).abs())
    tramo = lambda k: 0 if k <= 3 else 1 if k <= 6 else 2
    err['T'] = err['H'].map(tramo)
    filas = []
    for k, (f, p) in enumerate(zip(fechas, pred), start=1):
        r = err.loc[err['T'] == tramo(min(k, 12)), 'R']
        amp = np.sqrt(max(k, 12) / 12)
        q80, q90, q95 = (float(np.quantile(r, c)) * amp for c in (0.80, 0.90, 0.95))
        filas.append({'FECHA': f, 'H': k, 'Pronóstico_kWh': p,
                      'Inferior_80': p * (1 - q80), 'Superior_80': p * (1 + q80),
                      'Inferior_90': p * (1 - q90), 'Superior_90': p * (1 + q90),
                      'Inferior_95': p * (1 - q95), 'Superior_95': p * (1 + q95), 'Modelo': modelo})
    return pd.DataFrame(filas), m


# ==========================================================================================================
# Nivel usuario y cuenta
# ==========================================================================================================
def panel(base: pr.Base, nivel: str) -> pd.DataFrame:
    """Matriz entidad × mes (NaN = sin registro). nivel: 'usuario' o 'cuenta'."""
    clave = 'CODIGO_USUARIO' if nivel == 'usuario' else 'CUENTA'   # las cuentas se identifican con su número real
    p = base.analisis.pivot_table(index=clave, columns='FECHA', values='TOTAL_ACTIVA', aggfunc='sum')
    return p.reindex(columns=pd.date_range(p.columns.min(), base.ultimo_mes, freq='MS'))


def nivel_entidades(base: pr.Base, nivel: str, cal: pd.DataFrame, hasta: str = MES_OBJETIVO, modelos=None,
                    verbose: bool = True):
    """Selecciona y aplica el mejor modelo de cada entidad activa (con registro en el último mes).

    - Serie de cada entidad: desde su primer registro; los meses sin registro intermedios cuentan como 0 kWh.
    - Si la serie permite dejar 12 meses de prueba, se evalúan todos los modelos que caben en el resto y se
      elige el de menor MAE en esa prueba. Si no, se usa el promedio móvil de 12 meses (sin evaluación).
    - Las entidades sin registro en el último mes no se pronostican (se asume que dejaron de consumir).
    - Intervalos del 80 % y 90 %: ± el percentil 80 y 90 del error absoluto (kWh) que tuvo el modelo elegido en
      la prueba de 12 meses de esa misma entidad; para horizontes mayores a 12 meses se amplían con √(h/12).
      Si la entidad no tuvo prueba, se usa el error relativo típico del nivel aplicado a su pronóstico.
    """
    modelos = modelos or MODELOS
    pnl = panel(base, nivel)
    activos = pnl.index[pnl.iloc[:, -1].notna()]
    fin = pd.Timestamp(f'{hasta}-01')
    h_fut = (fin.year - base.ultimo_mes.year) * 12 + fin.month - base.ultimo_mes.month
    fechas_fut = pd.date_range(base.ultimo_mes + pd.offsets.MonthBegin(1), periods=h_fut, freq='MS')
    asign, metr, pron = [], [], {}
    t0 = time.time()
    for ent in activos:
        fila = pnl.loc[ent]
        s = fila.loc[fila.first_valid_index():].fillna(0.0)
        train, test = s.iloc[:-HORIZONTE_VALIDACION], s.iloc[-HORIZONTE_VALIDACION:]
        cand = [n for n in modelos if len(train) >= crear_modelo(n, cal).min_obs] if len(s) > HORIZONTE_VALIDACION else []
        res, preds = {}, {}
        escala = escala_mase(train.values)
        for n in cand:
            p = crear_modelo(n, cal, ligero=True).ajustar(train).pronosticar(HORIZONTE_VALIDACION)
            preds[n] = np.maximum(p, 0)
            res[n] = utils.metricas(test.values, preds[n], escala)
            metr.append({'Entidad': ent, 'Modelo': n, **res[n], 'Consumo_prueba_kWh': float(test.sum())})
        mejor = min(res, key=lambda n: res[n]['MAE']) if res else 'Promedio móvil 12 m'
        p_fut = np.maximum(crear_modelo(mejor, cal, ligero=True).ajustar(s).pronosticar(h_fut), 0)
        pron[ent] = p_fut
        err = np.abs(test.values - preds[mejor]) if res else None
        asign.append({'Entidad': ent, 'Modelo': mejor, 'Evaluado': bool(res), 'Meses_historia': len(s),
                      'Q80': float(np.quantile(err, 0.80)) if res else np.nan, 'Q90': float(np.quantile(err, 0.90)) if res else np.nan,
                      'Q_REL': list(err / max(float(test.mean()), 1.0)) if res else [],
                      **({k: v for k, v in res[mejor].items()} if res else {})})
    if verbose:
        print(f'  {nivel}: {len(activos)} activos de {len(pnl)} · {time.time() - t0:.0f} s')
    asign = pd.DataFrame(asign).set_index('Entidad')
    metr = pd.DataFrame(metr)
    pron = pd.DataFrame(pron, index=fechas_fut).T
    # Entidades sin prueba: error relativo típico del nivel (percentiles de todos los errores relativos evaluados)
    rel = np.concatenate([np.asarray(v, float) for v in asign['Q_REL'] if len(v)]) if asign['Evaluado'].any() else np.array([0.2])
    sin = ~asign['Evaluado']
    asign.loc[sin, 'Q80'] = pron.loc[asign.index[sin]].mean(axis=1) * float(np.quantile(rel, 0.80))
    asign.loc[sin, 'Q90'] = pron.loc[asign.index[sin]].mean(axis=1) * float(np.quantile(rel, 0.90))
    asign = asign.drop(columns='Q_REL')
    # Resumen por modelo: veces que gana y error ponderado (WAPE) sobre todas las entidades evaluadas
    resumen = (metr.assign(AE=lambda d: d['WAPE_%'] * d['Consumo_prueba_kWh'] / 100)
               .groupby('Modelo').agg(Entidades=('Entidad', 'nunique'), AE=('AE', 'sum'), Consumo=('Consumo_prueba_kWh', 'sum'),
                                      MAPE_mediano=('MAPE_%', 'median'), MASE_mediano=('MASE', 'median')))
    resumen['WAPE_%'] = resumen['AE'] / resumen['Consumo'] * 100
    resumen['Veces_mejor'] = asign['Modelo'].value_counts().reindex(resumen.index).fillna(0).astype(int)
    resumen = resumen.drop(columns=['AE', 'Consumo']).sort_values('WAPE_%')
    return {'panel': pnl, 'asignacion': asign, 'metricas': metr, 'pronostico': pron, 'resumen': resumen,
            'inactivos': pnl.index.difference(activos)}


# ==========================================================================================================
# Exportación
# ==========================================================================================================
@dataclass
class Resultados:
    base: pr.Base
    serie: pd.Series
    cal: pd.DataFrame
    bt: pd.DataFrame
    hiper: pd.DataFrame
    comp: dict
    pron: pd.DataFrame
    modelo_final: Modelo
    usuarios: dict
    cuentas: dict
    extra: dict = field(default_factory=dict)


def resumen_anual(res: Resultados) -> pd.DataFrame:
    real = res.serie.groupby(res.serie.index.year).sum()
    pron = res.pron.set_index('FECHA')['Pronóstico_kWh']
    pron_a = pron.groupby(pron.index.year).sum()
    anios = sorted(set(real.index) | set(pron_a.index))
    t = pd.DataFrame({'Año': anios, 'Real (GWh)': [real.get(a, 0) / 1e6 for a in anios],
                      'Pronóstico (GWh)': [pron_a.get(a, 0) / 1e6 for a in anios]})
    t['Total (GWh)'] = t['Real (GWh)'] + t['Pronóstico (GWh)']
    t['Variación %'] = t['Total (GWh)'].pct_change() * 100
    t['Meses reales'] = [int((res.serie.index.year == a).sum()) for a in anios]
    return t


def amplitud_horizonte(k: int) -> float:
    """Factor de ampliación del intervalo para horizontes mayores a 12 meses."""
    return float(np.sqrt(max(k, 12) / 12))


def intervalos_entidades(d: dict) -> pd.DataFrame:
    """Pronóstico mensual de cada entidad con intervalos del 80 % y 90 % (formato largo, kWh)."""
    filas = []
    for ent, fila in d['pronostico'].iterrows():
        q80, q90 = d['asignacion'].at[ent, 'Q80'], d['asignacion'].at[ent, 'Q90']
        for k, (f, p) in enumerate(fila.items(), start=1):
            a = amplitud_horizonte(k)
            filas.append({'Entidad': ent, 'Mes': f, 'Meses adelante': k, 'Pronóstico (kWh)': p,
                          'Inferior 80 % (kWh)': max(p - q80 * a, 0.0), 'Superior 80 % (kWh)': p + q80 * a,
                          'Inferior 90 % (kWh)': max(p - q90 * a, 0.0), 'Superior 90 % (kWh)': p + q90 * a})
    return pd.DataFrame(filas)


ESTADOS = ['Con pronóstico', 'Sin registro en el último mes completo', 'Solo registra el mes incompleto']


def catalogo_nivel(res: Resultados, nivel: str):
    """Todas las entidades del nivel (152 usuarios o 701 cuentas) con su estado, modelo, métricas y totales.

    Estado 0 = con pronóstico (registro en el último mes completo); 1 = sin registro en ese mes (no se pronostica);
    2 = solo aparece en el mes incompleto excluido (no tiene meses completos para modelar).
    Devuelve (catálogo, panel histórico, pronóstico) con el mismo índice y ordenados por consumo de los últimos 12 meses.
    """
    base = res.base
    d = res.usuarios if nivel == 'usuario' else res.cuentas
    u = base.usuarios.reset_index().set_index('CODIGO')
    completo = base.completo.assign(CODIGO_USUARIO=base.completo['USUARIO'].map(base.usuarios['CODIGO']))
    if nivel == 'usuario':
        cat = pd.DataFrame({'Usuario': u['ETIQUETA'], 'Segmento': u['SEGMENTO'], 'Cuentas': u['CUENTAS']})
        ult = completo.groupby('CODIGO_USUARIO')['FECHA'].max()
    else:
        c = base.cuentas.set_index('CUENTA')
        cat = pd.DataFrame({'Código usuario': c['CODIGO_USUARIO'], 'Usuario': c['CODIGO_USUARIO'].map(u['ETIQUETA']),
                            'Segmento': c['CODIGO_USUARIO'].map(u['SEGMENTO']), 'Ciclo': c['CICLO'].astype(int)})
        ult = completo.groupby('CUENTA')['FECHA'].max()
    cat['ESTADO'] = np.where(cat.index.isin(d['pronostico'].index), 0, np.where(cat.index.isin(d['panel'].index), 1, 2))
    cat['Último registro'] = ult.reindex(cat.index).dt.strftime('%Y-%m')
    a = d['asignacion'].reindex(cat.index)
    cat['Modelo'] = a['Modelo']
    cat['MAPE %'], cat['WAPE %'], cat['R²'] = a.get('MAPE_%'), a.get('WAPE_%'), a.get('R2')
    pnl = d['panel'].reindex(cat.index)
    pron = d['pronostico'].reindex(cat.index)
    cat['Real 2025 (kWh)'] = pnl.loc[:, pnl.columns.year == 2025].sum(axis=1, min_count=1)
    cat['Pronóstico 2027 (kWh)'] = pron.loc[:, pron.columns.year == 2027].sum(axis=1, min_count=1)
    orden = pnl.iloc[:, -12:].sum(axis=1).fillna(0).sort_values(ascending=False, kind='stable').index
    orden = list(orden[cat.loc[orden, 'ESTADO'] == 0]) + list(orden[cat.loc[orden, 'ESTADO'] != 0])
    return cat.loc[orden], pnl.loc[orden], pron.loc[orden]


def tabla_ancha(res: Resultados, nivel: str) -> pd.DataFrame:
    """Una fila por entidad (todas) y una columna por mes pronosticado, para Excel."""
    cat, _, pron = catalogo_nivel(res, nivel)
    mes_ult = res.base.ultimo_mes.strftime('%Y-%m')
    excl = ', '.join(sorted(res.base.excluidos['FECHA'].dt.strftime('%Y-%m').unique()))
    txt = {0: 'Con pronóstico', 1: f'Sin registro en {mes_ult}: no se pronostica', 2: f'Solo registra {excl} (mes incompleto): no se pronostica'}
    t = cat.drop(columns='ESTADO').copy()
    t.insert(list(t.columns).index('Último registro'), 'Estado', cat['ESTADO'].map(txt))
    for f in pron.columns:
        t[f'{f:%Y-%m} (kWh)'] = pron[f].round()
    t['Real 2025 (kWh)'] = t['Real 2025 (kWh)'].round()
    t['Pronóstico 2027 (kWh)'] = t['Pronóstico 2027 (kWh)'].round()
    t['Variación 2027 vs 2025 %'] = (t['Pronóstico 2027 (kWh)'] / t['Real 2025 (kWh)'].where(t['Real 2025 (kWh)'] > 0) - 1) * 100
    t.index = t.index.astype(str)
    t.index.name = 'Código' if nivel == 'usuario' else 'Cuenta'
    return t.reset_index()


def exportar_resultados(res: Resultados) -> dict:
    """Escribe predicciones.xlsx, indicadores.xlsx y el modelo global persistido (joblib)."""
    import joblib
    base, comp = res.base, res.comp
    u_cat = base.usuarios.set_index('CODIGO')
    c_cat = base.cuentas.set_index('CUENTA')
    fmt_kwh = '#,##0'

    g = res.pron.copy()
    COLS_G = ['Pronóstico_kWh', 'Inferior_80', 'Superior_80', 'Inferior_90', 'Superior_90', 'Inferior_95', 'Superior_95']
    for c in COLS_G:
        g[c] = g[c].round()

    def mensual(nivel):
        d = res.usuarios if nivel == 'usuario' else res.cuentas
        t = intervalos_entidades(d)
        num = [c for c in t.columns if 'kWh' in c]
        t[num] = t[num].round()
        if nivel == 'usuario':
            t.insert(1, 'Usuario', t['Entidad'].map(u_cat['ETIQUETA']))
            t.insert(2, 'Segmento', t['Entidad'].map(u_cat['SEGMENTO']))
            t = t.rename(columns={'Entidad': 'Código'})
        else:
            t.insert(1, 'Código usuario', t['Entidad'].map(c_cat['CODIGO_USUARIO']))
            t.insert(2, 'Usuario', t['Código usuario'].map(u_cat['ETIQUETA']))
            t.insert(3, 'Ciclo', t['Entidad'].map(c_cat['CICLO']))
            t['Entidad'] = t['Entidad'].astype(str)
            t = t.rename(columns={'Entidad': 'Cuenta'})
        t.insert(t.columns.get_loc('Pronóstico (kWh)') + 1, 'Modelo', t.iloc[:, 0].map(
            lambda e: d['asignacion']['Modelo'].rename(index=str).get(str(e))))
        return t

    prueba = res.bt[res.bt['Origen'] == comp['origen_prueba']].pivot_table(index='FECHA', columns='Modelo', values='Pronóstico')
    prueba = prueba[comp['cv'].index].round()
    prueba.insert(0, 'Real', res.serie.reindex(prueba.index).values)
    prueba = prueba.reset_index().rename(columns={'FECHA': 'Mes'})

    u_ab = res.usuarios['pronostico'].sum()
    coher = pd.DataFrame({'Mes': res.pron['FECHA'], 'Modelo global (kWh)': g['Pronóstico_kWh'].values,
                          'Suma de usuarios (kWh)': u_ab.reindex(res.pron['FECHA']).round().values,
                          'Suma de cuentas (kWh)': res.cuentas['pronostico'].sum().reindex(res.pron['FECHA']).round().values})
    coher['Diferencia usuarios vs global %'] = (coher['Suma de usuarios (kWh)'] / coher['Modelo global (kWh)'] - 1) * 100

    t_usr, t_cta = tabla_ancha(res, 'usuario'), tabla_ancha(res, 'cuenta')
    fmts = {c: fmt_kwh for c in COLS_G + ['Real']}
    m_usr, m_cta = mensual('usuario'), mensual('cuenta')
    r_pred = utils.exportar_excel(utils.RUTA_PREDICCIONES, [
        dict(hoja='Pronóstico global', tabla=g.rename(columns={'FECHA': 'Mes'}), formatos=fmts,
             titulo=f'Pronóstico mensual del consumo total hasta {MES_OBJETIVO} (kWh)',
             descripcion=f'Modelo: {comp["mejor"]}. Intervalos empíricos del 80 %, 90 % y 95 % a partir de los errores de la validación temporal.'),
        dict(hoja='Resumen anual', tabla=resumen_anual(res), titulo='Consumo anual real y pronosticado (GWh)',
             descripcion='2026 combina meses reales (hasta el último mes completo) y pronosticados.'),
        dict(hoja='Por usuario', tabla=t_usr, formatos={c: fmt_kwh for c in t_usr.columns if 'kWh' in c},
             titulo=f'Pronóstico por usuario: los {len(t_usr)} usuarios (kWh)',
             descripcion='Una fila por usuario y una columna por mes. Cada usuario con registro en el último mes usa el modelo que mejor predijo su serie; los demás se listan con su estado. Nombres de personas naturales protegidos.'),
        dict(hoja='Por cuenta', tabla=t_cta, formatos={c: fmt_kwh for c in t_cta.columns if 'kWh' in c},
             titulo=f'Pronóstico por cuenta: las {len(t_cta)} cuentas (kWh)',
             descripcion='Una fila por cuenta (número real) y una columna por mes. Cada cuenta con registro en el último mes usa el modelo que mejor predijo su serie; las demás se listan con su estado.'),
        dict(hoja='Usuarios mensual', tabla=m_usr, formatos={c: fmt_kwh for c in m_usr.columns if 'kWh' in c},
             titulo='Pronóstico mensual por usuario con intervalos del 80 % y 90 % (kWh)',
             descripcion='Una fila por usuario y mes. Intervalo = ± percentil 80/90 del error absoluto que tuvo el modelo de ese usuario en su prueba de 12 meses (ampliado con √(h/12) después de 12 meses).'),
        dict(hoja='Cuentas mensual', tabla=m_cta, formatos={c: fmt_kwh for c in m_cta.columns if 'kWh' in c},
             titulo='Pronóstico mensual por cuenta con intervalos del 80 % y 90 % (kWh)',
             descripcion='Una fila por cuenta (número real) y mes. Mismo método de intervalos que por usuario.'),
        dict(hoja='Prueba por modelo', tabla=prueba, formatos={c: fmt_kwh for c in prueba.columns if c != 'Mes'},
             titulo='Prueba final: real y pronóstico de cada modelo (kWh)',
             descripcion=f'Modelos entrenados hasta {comp["origen_prueba"]:%Y-%m} y evaluados en los 12 meses siguientes.'),
        dict(hoja='Coherencia', tabla=coher, formatos={c: fmt_kwh for c in coher.columns if 'kWh' in c},
             titulo='Coherencia entre niveles', descripcion='Compara el pronóstico global con la suma de los pronósticos por usuario y por cuenta.'),
    ], 'Predicciones de consumo de usuarios especiales')

    def met(t):
        t = t.reset_index().rename(columns={'MAPE_%': 'MAPE %', 'WAPE_%': 'WAPE %', 'Sesgo_%': 'Sesgo %', 'R2': 'R²',
                                            'Mejora_vs_naive_%': 'Mejora vs naive %'})
        return t
    por_h = comp['por_h'].reset_index().rename(columns={'H': 'Horizonte (meses)'})
    asig_u = res.usuarios['asignacion'].reset_index().rename(columns={'Entidad': 'Código'})
    asig_u.insert(1, 'Usuario', asig_u['Código'].map(u_cat['ETIQUETA']))
    asig_c = res.cuentas['asignacion'].reset_index().rename(columns={'Entidad': 'Cuenta'})
    asig_c.insert(1, 'Código usuario', asig_c['Cuenta'].map(c_cat['CODIGO_USUARIO']))
    asig_c.insert(2, 'Usuario', asig_c['Código usuario'].map(u_cat['ETIQUETA']))
    asig_c['Cuenta'] = asig_c['Cuenta'].astype(str)
    anual = resumen_anual(res)
    r_ind = utils.exportar_excel(utils.RUTA_INDICADORES, [
        dict(hoja='Métricas validación', tabla=met(comp['cv']), titulo='Comparación de modelos: validación cruzada temporal',
             descripcion=f'{res.bt["Origen"].nunique()} orígenes × 12 meses. Ordenado por {comp["criterio"]}. MAE y RMSE en kWh.'),
        dict(hoja='Métricas prueba final', tabla=met(comp['prueba']), titulo='Comparación de modelos: prueba final (últimos 12 meses)',
             descripcion=f'Entrenamiento hasta {comp["origen_prueba"]:%Y-%m}.'),
        dict(hoja='Error por horizonte', tabla=por_h, titulo='MAPE (%) según meses hacia adelante',
             descripcion='Promedio sobre los orígenes de validación.'),
        dict(hoja='Hiperparámetros', tabla=res.hiper, titulo='Hiperparámetros elegidos por GridSearchCV (TimeSeriesSplit)',
             descripcion='Un registro por modelo y origen de validación.'),
        dict(hoja='Modelos por usuario', tabla=met(res.usuarios['resumen']), titulo='Desempeño de los modelos a nivel usuario',
             descripcion='WAPE ponderado por consumo y número de usuarios en que cada modelo resultó el mejor.'),
        dict(hoja='Modelos por cuenta', tabla=met(res.cuentas['resumen']), titulo='Desempeño de los modelos a nivel cuenta',
             descripcion='WAPE ponderado por consumo y número de cuentas en que cada modelo resultó el mejor.'),
        dict(hoja='Asignación usuarios', tabla=met(asig_u.set_index('Código')), titulo='Modelo asignado a cada usuario',
             descripcion='Métricas de la prueba de 12 meses del modelo elegido.'),
        dict(hoja='Asignación cuentas', tabla=met(asig_c.set_index('Cuenta')), titulo='Modelo asignado a cada cuenta',
             descripcion='Métricas de la prueba de 12 meses del modelo elegido.'),
        dict(hoja='Demanda anual', tabla=anual, titulo='Indicador de demanda anual (GWh)', descripcion='Real y pronosticado.'),
    ], 'Indicadores de desempeño de los modelos de predicción')

    ruta_modelo = utils.DIR_MODELOS / 'modelo_global.joblib'
    joblib.dump({'modelo': comp['mejor'], 'estimador': res.modelo_final, 'entrenado_hasta': res.serie.index[-1].strftime('%Y-%m'),
                 'metricas_validacion': comp['cv'].loc[comp['mejor']].to_dict(), 'generado': datetime.now().isoformat()},
                ruta_modelo)
    return {'predicciones': r_pred, 'indicadores': r_ind, 'modelo': ruta_modelo}


def datos_dashboard_prediccion(res: Resultados) -> dict:
    comp, serie = res.comp, res.serie
    R = utils.redondear
    u_cat = res.base.usuarios.set_index('CODIGO')
    c_cat = res.base.cuentas.set_index('CUENTA')
    orden = list(comp['cv'].index)

    def tabla(t):
        return {c: R(t[c].values, 4) for c in ['MAE', 'RMSE', 'MAPE_%', 'WAPE_%', 'R2', 'Sesgo_%', 'MASE', 'Mejora_vs_naive_%']}

    pr_test = res.bt[res.bt['Origen'] == comp['origen_prueba']]
    fechas_test = sorted(pr_test['FECHA'].unique())

    def entidades(d, nivel):
        cat, pnl, pron = catalogo_nivel(res, nivel)
        mt = d['metricas']
        mae = mt.pivot_table(index='Entidad', columns='Modelo', values='MAE').reindex(columns=orden)
        mape = mt.pivot_table(index='Entidad', columns='Modelo', values='MAPE_%').reindex(columns=orden)
        out = []
        for ent in cat.index:
            c = cat.loc[ent]
            est = int(c['ESTADO'])
            reg = {'cod': str(ent), 'est': est, 'ult': c['Último registro'] if isinstance(c['Último registro'], str) else '',
                   'mod': orden.index(c['Modelo']) if c['Modelo'] in orden else -1,
                   'h': R(pnl.loc[ent].values), 'p': R(pron.loc[ent].values) if est == 0 else None,
                   'mape': R([c['MAPE %']], 2)[0], 'wape': R([c['WAPE %']], 2)[0], 'r2': R([c['R²']], 3)[0],
                   'q80': R([d['asignacion'].at[ent, 'Q80']])[0] if est == 0 else None,
                   'q90': R([d['asignacion'].at[ent, 'Q90']])[0] if est == 0 else None,
                   'mae_m': R(mae.loc[ent].values) if ent in mae.index else None,
                   'mape_m': R(mape.loc[ent].values, 2) if ent in mape.index else None}
            if nivel == 'usuario':
                reg.update(nom=c['Usuario'], seg=c['Segmento'])
            else:
                reg.update(usr=c['Código usuario'], nom=c['Usuario'], seg=c['Segmento'], ciclo=int(c['Ciclo']))
            out.append(reg)
        return out

    def resumen(d):
        r = d['resumen'].reindex(orden)
        return {'wape': R(r['WAPE_%'].values, 2), 'mape_med': R(r['MAPE_mediano'].values, 2),
                'mase_med': R(r['MASE_mediano'].values, 3), 'veces': R(r['Veces_mejor'].fillna(0).values),
                'evaluados': int(d['asignacion']['Evaluado'].sum()), 'activos': int(len(d['asignacion'])),
                'inactivos': int(len(d['inactivos']))}

    excl = ', '.join(sorted(res.base.excluidos['FECHA'].dt.strftime('%Y-%m').unique()))

    anual = resumen_anual(res)
    return {
        'meta': {'generado': datetime.now().strftime('%Y-%m-%d %H:%M'), 'ultimo_mes': serie.index[-1].strftime('%Y-%m'),
                 'mes_objetivo': MES_OBJETIVO, 'mejor': comp['mejor'], 'criterio': comp['criterio'],
                 'origenes': [o.strftime('%Y-%m') for o in sorted(res.bt['Origen'].unique())],
                 'origen_prueba': comp['origen_prueba'].strftime('%Y-%m'), 'mes_excluido': excl},
        'modelos': orden, 'descripcion': [CATALOGO[m] for m in orden],
        'hist': {'meses': [f.strftime('%Y-%m') for f in serie.index], 'v': R(serie.values)},
        'cv': tabla(comp['cv']), 'prueba': tabla(comp['prueba'].reindex(orden)),
        'por_h': {m: R(comp['por_h'][m].values, 2) for m in orden},
        'por_origen': {'origenes': [o.strftime('%Y-%m') for o in comp['por_origen'].columns],
                       'v': {m: R(comp['por_origen'].loc[m].values, 2) for m in orden}},
        'test': {'meses': [pd.Timestamp(f).strftime('%Y-%m') for f in fechas_test],
                 'real': R(serie.reindex(fechas_test).values),
                 'pred': {m: R(pr_test[pr_test['Modelo'] == m].sort_values('FECHA')['Pronóstico'].values) for m in orden}},
        'errores': {m: R(res.bt[res.bt['Modelo'] == m]['Error_%'].values, 2) for m in orden},
        'pron': {'meses': [f.strftime('%Y-%m') for f in res.pron['FECHA']],
                 **{k: R(res.pron[c].values) for k, c in [('p', 'Pronóstico_kWh'), ('i80', 'Inferior_80'), ('s80', 'Superior_80'),
                                                           ('i90', 'Inferior_90'), ('s90', 'Superior_90'),
                                                           ('i95', 'Inferior_95'), ('s95', 'Superior_95')]}},
        'anual': {'anios': anual['Año'].astype(int).tolist(), 'real': R(anual['Real (GWh)'].values, 3),
                  'pron': R(anual['Pronóstico (GWh)'].values, 3), 'meses_reales': anual['Meses reales'].tolist()},
        'usuarios': {'lista': entidades(res.usuarios, 'usuario'), 'resumen': resumen(res.usuarios),
                     'suma': R(res.usuarios['pronostico'].sum().values)},
        'cuentas': {'lista': entidades(res.cuentas, 'cuenta'), 'resumen': resumen(res.cuentas),
                    'suma': R(res.cuentas['pronostico'].sum().values)},
        'hiper': {m: (res.hiper[(res.hiper['Modelo'] == m)].iloc[-1]['Parámetros'] if (res.hiper['Modelo'] == m).any() else '')
                  for m in orden},
    }


def generar_data_js(res: Resultados):
    """static/js/data.js con los datos de los dos dashboards (exploratorio y predicción)."""
    return utils.escribir_data_js(DATOS_EDA=pr.datos_dashboard_eda(res.base), DATOS_PRED=datos_dashboard_prediccion(res))


# ==========================================================================================================
# Ejecución completa
# ==========================================================================================================
def ejecutar(verbose: bool = True) -> Resultados:
    t0 = time.time()
    base = pr.preparar_base()
    pr.escribir_catalogo_usuarios(base)
    pr.escribir_variables_externas('2020-01-01', f'{MES_OBJETIVO}-01')
    serie, cal = datos_modelado(base)
    if verbose:
        print(f'Serie global: {serie.index[0]:%Y-%m} a {serie.index[-1]:%Y-%m} ({len(serie)} meses)')
    bt, hiper = validar(serie, cal, verbose=verbose)
    comp = comparar(bt)
    pron, final = pronostico_final(serie, cal, comp['mejor'], bt)
    usuarios = nivel_entidades(base, 'usuario', cal, verbose=verbose)
    cuentas = nivel_entidades(base, 'cuenta', cal, verbose=verbose)
    res = Resultados(base, serie, cal, bt, hiper, comp, pron, final, usuarios, cuentas)
    if verbose:
        print(f'Mejor modelo global: {comp["mejor"]} · {time.time() - t0:.0f} s')
    return res


def main():
    res = ejecutar()
    rutas = exportar_resultados(res)
    rutas['data_js'] = generar_data_js(res)
    for k, v in rutas.items():
        print(f'{k:>12}: {v}')


if __name__ == '__main__':
    main()
