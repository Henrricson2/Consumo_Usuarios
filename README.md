# Consumo_Usuarios · Análisis exploratorio y predicción del consumo de energía

Proyecto de analítica sobre el consumo mensual de energía activa (kWh) de los **usuarios especiales (no regulados) de Electrohuila**: 701 cuentas que se consolidan en **152 usuarios**, enero de 2020 a septiembre de 2026.

| Etapa | Cuaderno | Dashboard |
|---|---|---|
| Análisis exploratorio | `homework/Analisis_Exploratorio.ipynb` | `templates/dashboard_analisis_exploratorio.html` |
| Predicción hasta dic-2027 | `homework/Prediccion.ipynb` | `templates/dashboard_prediccion.html`: pestañas **Predicción global**, **Predicción por usuario** (152) y **Predicción por cuenta** (701) |
| Presentación de ambos | — | **`templates/index.html`** (dos pestañas) |

## Estructura

```
Consumo_Usuarios/
├── data/
│   ├── input/
│   │   ├── consumos.xlsx              # fuente: tabla estadistica_usuario (tipo_usuario = NR)
│   │   ├── usuarios.xlsx              # catálogo de usuarios y cuentas consolidados (generado desde consumos.xlsx)
│   │   └── variables_externas.csv     # calendario 2020–2027: días hábiles, sábados, domingos y festivos de Colombia
│   └── output/
│       ├── predicciones.xlsx          # pronóstico mensual global, por usuario (152) y por cuenta (701), con intervalos
│       ├── indicadores.xlsx           # métricas de los modelos (MAE, RMSE, MAPE, WAPE, R², sesgo, MASE) y demanda anual
│       ├── base_datos/                # base del análisis exploratorio (CSV y SQLite)
│       ├── modelos/                   # modelo global ganador entrenado (joblib)
│       └── reportes/
│           ├── analisis_exploratorio/ # figuras/ y tablas/ del análisis exploratorio
│           └── prediccion/figuras/    # figuras del cuaderno de predicción
├── homework/
│   ├── Analisis_Exploratorio.ipynb
│   └── Prediccion.ipynb
├── templates/
│   ├── index.html                             # página principal: pestañas Análisis exploratorio | Predicción
│   ├── dashboard_analisis_exploratorio.html
│   └── dashboard_prediccion.html
├── static/
│   ├── css/styles.css                 # estilos compartidos (paleta igual a las figuras de los cuadernos)
│   ├── js/
│   │   ├── app.js                     # lógica de cada página (motor del exploratorio, predicción, inicio)
│   │   ├── charts.js                  # componentes: Plotly en español, KPIs, tablas con CSV, pestañas, ayudas
│   │   ├── data.js                    # datos de los dashboards (generado, no editar)
│   │   └── vendor/plotly.min.js       # Plotly.js local: los dashboards funcionan sin internet
│   └── assets/ (img/, icons/, logo/)
├── src/
│   ├── procesamiento.py               # carga, consolidación de usuarios, calendario, datos del dashboard exploratorio
│   ├── prediccion.py                  # modelos, validación temporal, selección, pronóstico y exportación
│   └── utils.py                       # rutas, estilo gráfico, métricas, Excel con formato, data.js
├── requirements.txt
└── README.md
```

## Instalación

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows  (Linux/Mac: source .venv/bin/activate)
pip install -r requirements.txt
```

Probado con Python 3.9 (pandas 2.3, scikit-learn 1.6) y Python 3.13 (pandas 3.0, scikit-learn 1.9).

## Uso

1. **Análisis exploratorio:** abrir `homework/Analisis_Exploratorio.ipynb` y ejecutar *Restart → Run All*. Escribe sus figuras y tablas en `data/output/reportes/analisis_exploratorio/` y la base en `data/output/base_datos/`.
2. **Predicción:** abrir `homework/Prediccion.ipynb` y ejecutar *Run All* (unos 4 minutos). También se puede ejecutar sin el cuaderno:
   ```bash
   python -m src.prediccion
   ```
   Genera `usuarios.xlsx`, `variables_externas.csv`, `predicciones.xlsx`, `indicadores.xlsx`, el modelo y `static/js/data.js`.
3. **Dashboards:** abrir `templates/index.html` en el navegador (doble clic). No necesita servidor ni internet.

Los cuadernos funcionan desde `homework/` o desde la raíz del proyecto: la raíz se detecta automáticamente.

## Método de predicción

| Paso | Detalle |
|---|---|
| Serie | Consumo mensual total en kWh, enero de 2020 a septiembre de 2026. Octubre de 2026 se excluye porque está incompleto (2 registros). |
| Modelos | Naive estacional y promedio móvil de 12 meses (referencias), Holt-Winters amortiguado, regresión estacional, Ridge con rezagos, Random Forest y Gradient Boosting. Los tres últimos usan rezagos de 1, 2, 3 y 12 meses, estacionalidad, tendencia y días hábiles. |
| Validación | Origen móvil: 5 orígenes (sep-2024 a sep-2025) × 12 meses hacia adelante, sin usar datos futuros. El último origen es la prueba final. Los hiperparámetros se eligen con `GridSearchCV` + `TimeSeriesSplit`, dentro de cada entrenamiento. |
| Métricas | MAE, RMSE, MAPE, WAPE, R², sesgo, MASE y mejora frente al naive estacional. |
| Selección | Menor MAPE en la validación cruzada temporal. |
| Pronóstico | Mensual hasta diciembre de 2027. Global con intervalos del 80 %, 90 % y 95 % (errores relativos de la validación). |
| Niveles | Global, por usuario y por cuenta. Cada usuario y cada cuenta activa usa el modelo de menor MAE en su propia prueba de 12 meses, con intervalos mensuales del 80 % y 90 % (± percentil del error absoluto de esa prueba; ampliados con √(h/12) después de 12 meses). |

**Resultado actual:**
- **Modelo elegido:** Gradient Boosting, con MAPE de 7,2 % en la validación y 5,2 % en la prueba final. Reduce el MAE en 22 % frente al naive estacional.
- **Pronóstico:** 2026 cerraría en ≈ 144 GWh y 2027 en ≈ 147 GWh (+2 %).

El detalle y las interpretaciones están en `homework/Prediccion.ipynb`.

## Privacidad

En las salidas para compartir (dashboards, `predicciones.xlsx` por usuario, figuras), los nombres de probables personas naturales se reemplazan por su código (`Persona natural Uxxx`). Las cuentas se muestran con su **número real** para poder ubicarlas. `data/input/usuarios.xlsx` y las hojas de homologación del análisis exploratorio contienen los nombres originales: son de uso interno.

## Limitaciones

- La fuente no tiene municipio ni zona (la dirección es texto libre), así que no hay análisis geográfico. Se usan el ciclo de facturación y el segmento.
- Los únicos datos externos son los del calendario. Se pueden agregar columnas a `variables_externas.csv` (temperatura, actividad económica), siempre que cubran también los meses a pronosticar.
- La unidad de `TOTAL_ACTIVA` (kWh) se infiere de los datos; el archivo no la declara.
