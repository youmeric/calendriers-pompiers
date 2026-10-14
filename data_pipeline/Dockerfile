FROM python:3.12-slim

WORKDIR /app/data_pipeline
COPY data_pipeline/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY data_pipeline/ .

ENTRYPOINT ["python", "run_pipeline.py"]
