"""Private gRPC/UDS server for WHO calculations and growth screening."""

from __future__ import annotations

import json
import logging
import os
import threading
from concurrent import futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from . import charts, who
from .generated import analysis_pb2, analysis_pb2_grpc


LOGGER = logging.getLogger("eposyandu.analysis")
TOKEN_HEADER = "x-eposyandu-service-token"


def _optional(request, name: str):
    return getattr(request, name) if request.HasField(name) else None


class AnalysisServicer(analysis_pb2_grpc.AnalysisServiceServicer):
    def _authorize(self, context) -> None:
        expected = os.environ.get("RUST_WORKER_SHARED_SECRET", "").strip()
        supplied = next(
            (value for key, value in context.invocation_metadata() if key.lower() == TOKEN_HEADER),
            "",
        )
        if not expected:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "Secret service gRPC belum dikonfigurasi.")
        if supplied != expected:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "Token service gRPC tidak valid.")

    def CalculateBatch(self, request, context):  # noqa: N802 (protobuf API name)
        self._authorize(context)
        items = []
        for item in request.items:
            try:
                history = json.loads(item.history_json) if item.history_json else []
            except json.JSONDecodeError:
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Riwayat pengukuran tidak valid.")
            if not isinstance(history, list):
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Riwayat pengukuran harus berupa array.")
            items.append(
                {
                    "weight_kg": item.weight_kg,
                    "height_cm": _optional(item, "height_cm"),
                    "age_months": item.age_months,
                    "sex": item.sex,
                    "measurement_method": _optional(item, "measurement_method"),
                    "row_number": item.row_number,
                    "record_id": item.record_id,
                    "nik": item.nik,
                    "lila_cm": _optional(item, "lila_cm"),
                    "head_circumference_cm": _optional(item, "head_circumference_cm"),
                    "history": history,
                    "measurement_date": item.measurement_date if item.HasField("measurement_date") else "",
                    "exclusive_breastfeeding": (
                        _optional(item, "exclusive_breastfeeding")
                        if item.HasField("exclusive_breastfeeding")
                        else None
                    ),
                }
            )
        try:
            result = who.calculate_batch(items)
        except (OSError, json.JSONDecodeError, KeyError, IndexError) as error:
            LOGGER.exception("Standar WHO tidak dapat dimuat")
            context.abort(grpc.StatusCode.INTERNAL, str(error))
        except ValueError as error:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(error))
        response = analysis_pb2.CalculateBatchResponse(
            underweight=result["underweight"],
            stunting=result["stunting"],
            wasting=result["wasting"],
            total=result["total"],
            standards_version=result["standards_version"],
            calculator=result["calculator"],
        )
        for item in result["items"]:
            assessment = response.items.add(
                row_number=item["row_number"],
                record_id=item["record_id"],
                nik=item["nik"],
                bbu_status=item["bbu_status"],
                tbu_status=item["tbu_status"],
                bbtb_status=item["bbtb_status"],
                imtu_status=item["imtu_status"],
                lila_status=item["lila_status"],
                lk_status=item["lk_status"],
            )
            for field in (
                "bbu_z_score",
                "tbu_z_score",
                "bbtb_z_score",
                "imtu_z_score",
                "lila_z_score",
                "lk_z_score",
            ):
                if item[field] is not None:
                    setattr(assessment, field, item[field])
            assessment.analysis_json = json.dumps(
                {
                    "anomaly": item.get("anomaly", {}),
                    "risk": item.get("risk", {}),
                    "nutritionConcern": item.get("nutrition_concern"),
                    "graphAnalysis": item.get("graph_analysis", {}),
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
        return response

    def RenderGrowthChart(self, request, context):  # noqa: N802 (protobuf API name)
        """Render one chart using the same private WHO LMS tables as status calculation."""

        self._authorize(context)
        points = []
        for point in request.points:
            points.append(
                {
                    "age_months": point.age_months,
                    "weight_kg": point.weight_kg,
                    "height_cm": _optional(point, "height_cm"),
                    "lila_cm": _optional(point, "lila_cm"),
                    "head_circumference_cm": _optional(point, "head_circumference_cm"),
                    "measurement_method": _optional(point, "measurement_method"),
                    "measurement_date": _optional(point, "measurement_date"),
                }
            )
        try:
            svg = charts.render_growth_chart(
                request.chart_type,
                request.sex,
                points,
                child_name=_optional(request, "child_name") or "",
                language=request.language or "id",
            )
        except ValueError as error:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except (OSError, json.JSONDecodeError, KeyError, IndexError) as error:
            LOGGER.exception("Standar WHO grafik tidak dapat dimuat")
            context.abort(grpc.StatusCode.INTERNAL, str(error))
        return analysis_pb2.RenderGrowthChartResponse(
            chart_type=request.chart_type,
            svg=svg,
            standards_version=who.STANDARDS_VERSION,
            renderer="python-svg-who-lms-v1",
        )


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path not in ("/", "/health", "/ready"):
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"E-Posyandu analysis service aktif\n")

    def log_message(self, format, *args):  # noqa: A002
        LOGGER.info("health %s", format % args)


def _serve_health(port: int) -> None:
    ThreadingHTTPServer(("0.0.0.0", port), HealthHandler).serve_forever()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    grpc_address = os.environ.get("ANALYSIS_GRPC_ADDR", "unix:///run/e-posyandu/analysis.sock").strip()
    health_port = int(os.environ.get("ANALYSIS_HTTP_PORT", "8082"))
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    analysis_pb2_grpc.add_AnalysisServiceServicer_to_server(AnalysisServicer(), server)
    health_servicer = health.HealthServicer()
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)
    health_servicer.set("eposyandu.analysis.v1.AnalysisService", health_pb2.HealthCheckResponse.SERVING)
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    if grpc_address.startswith("unix://"):
        socket_path = grpc_address.removeprefix("unix://")
        os.makedirs(os.path.dirname(socket_path), mode=0o700, exist_ok=True)
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
    if server.add_insecure_port(grpc_address) == 0:
        raise RuntimeError(f"Tidak dapat membuka endpoint gRPC {grpc_address}.")
    server.start()
    LOGGER.info("analysis service gRPC aktif pada %s", grpc_address)
    threading.Thread(target=_serve_health, args=(health_port,), daemon=True).start()
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        server.stop(grace=5)


if __name__ == "__main__":
    main()
