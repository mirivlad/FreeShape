FROM python:3.12-slim AS vendor
WORKDIR /src
COPY webcad/fetch_runtime.py /src/
RUN python fetch_runtime.py
COPY freeshape /src/freeshape
COPY LICENSE /site/LICENSE-FreeShape
COPY webcad/bridge.py /site/bridge.py
COPY webcad/site/ /site/
RUN python -c "import shutil; shutil.make_archive('/site/freeshape','zip','/src','freeshape')" \
 && python -c "import pathlib,json; p=pathlib.Path('/site'); (p/'offline-files.json').write_text(json.dumps(sorted(str(x.relative_to(p)) for x in p.rglob('*') if x.is_file())))"
FROM nginx:1.28-alpine
COPY webcad/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=vendor /site/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
