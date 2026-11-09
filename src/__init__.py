"""Paquete del proyecto Consumo_Usuarios (usuarios especiales de Electrohuila).

Módulos
-------
utils          Rutas del proyecto, estilo gráfico, formatos, métricas y exportación a Excel / JavaScript.
procesamiento  Carga del Excel de consumos, consolidación de usuarios (mismo método del análisis exploratorio),
               variables de calendario y datos del dashboard exploratorio.
prediccion     Modelos de pronóstico, validación temporal, selección del mejor modelo, pronóstico por niveles
               (global, usuario y cuenta) y exportación de resultados.

Ejecución completa desde la raíz del proyecto:  ``python -m src.prediccion``
"""
__version__ = '3.0'
