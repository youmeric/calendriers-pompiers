FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
COPY data_pipeline/requirements.txt ./requirements-pipeline.txt
# le pipeline (adresses BAN + routes OSM) est lancé par l'admin central pour chaque nouvelle caserne
RUN pip install --no-cache-dir -r requirements.txt -r requirements-pipeline.txt

COPY backend/app ./app
COPY frontend ./frontend
COPY data_pipeline ./data_pipeline
ENV PIPELINE_DIR=/app/data_pipeline

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
