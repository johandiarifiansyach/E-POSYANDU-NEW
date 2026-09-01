FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/services/analysis-service

WORKDIR /app
COPY services/analysis-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY services/analysis-service /app/services/analysis-service
COPY services/analysis-service/data/anthropometry.json /app/services/analysis-service/data/anthropometry.json
COPY frontend/src/data/whoGrowthLms.ts /app/frontend/src/data/whoGrowthLms.ts

RUN mkdir -p /app/services/analysis-service/analysis_service/generated \
  && python -m grpc_tools.protoc \
  -I /app/services/analysis-service/proto \
  --python_out=/app/services/analysis-service/analysis_service/generated \
  --grpc_python_out=/app/services/analysis-service/analysis_service/generated \
  /app/services/analysis-service/proto/analysis.proto \
  && touch /app/services/analysis-service/analysis_service/generated/__init__.py \
  && sed -i 's/^import analysis_pb2/from . import analysis_pb2/' \
    /app/services/analysis-service/analysis_service/generated/analysis_pb2_grpc.py

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin eposyandu \
  && install -d -o 10001 -g 10001 -m 0700 /run/e-posyandu
USER 10001:10001

EXPOSE 8082
ENTRYPOINT ["python", "-m", "analysis_service.server"]
