FROM python:3.13-slim

WORKDIR /code

# Build deps for psycopg2 (still useful even though we use psycopg2-binary,
# in case you switch to the non-binary version later).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]