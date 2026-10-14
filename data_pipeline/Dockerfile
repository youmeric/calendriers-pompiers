FROM python:3.12-slim

# affiche la progression au fil de l'eau (sinon Docker la bufferise jusqu'à la fin)
ENV PYTHONUNBUFFERED=1

WORKDIR /app/data_pipeline
COPY data_pipeline/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY data_pipeline/ .

ENTRYPOINT ["python", "run_pipeline.py"]
