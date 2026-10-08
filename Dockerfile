FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -m -u 10001 renrob && mkdir -p /data/orders && chown -R renrob:renrob /data
COPY server.py .
COPY web ./web
ENV HOST=0.0.0.0 PORT=8765 RENROB_DATA=/data RENROB_ORDERS=/data/orders RENROB_PI_TEMPLATE=/data/pi-template.xls
USER renrob
EXPOSE 8765
CMD ["python", "server.py"]
