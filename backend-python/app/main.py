from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import create_schema_if_enabled, get_session
from .realtime import realtime_manager
from .repository import (
    RESOURCE_NAMES,
    apply_entity,
    create_entity,
    get_document,
    list_documents,
    serialize,
)


class DocumentPayload(BaseModel):
    id: Optional[str] = None
    data: dict[str, Any] = Field(default_factory=dict)


def cors_origins() -> list[str]:
    configured = os.getenv('CORS_ORIGINS', 'http://localhost:5173')
    return [origin.strip() for origin in configured.split(',') if origin.strip()]


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_schema_if_enabled()
    yield


app = FastAPI(title='E-Posyandu API', version='1.0.0', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allow_headers=['Content-Type', 'Authorization'],
)


def validate_resource(resource_name: str) -> str:
    if resource_name not in RESOURCE_NAMES:
        raise HTTPException(status_code=404, detail='Koleksi data tidak ditemukan.')
    return resource_name


def parse_filter(value: str) -> tuple[str, str, str]:
    parts = value.split('|', 2)
    if len(parts) != 3 or parts[1] not in {'==', '>=', '<='}:
        raise HTTPException(status_code=422, detail='Format filter tidak valid.')
    return parts[0], parts[1], parts[2]


def parse_order(value: str) -> tuple[str, str]:
    parts = value.split('|', 1)
    if len(parts) != 2 or parts[1] not in {'asc', 'desc'}:
        raise HTTPException(status_code=422, detail='Format urutan tidak valid.')
    return parts[0], parts[1]


def document_response(resource_name: str, entity: Any) -> dict[str, Any]:
    return {'id': entity.id, 'data': serialize(resource_name, entity)}


@app.get('/api/health')
def health(session: Session = Depends(get_session)) -> dict[str, Any]:
    session.execute(text('select 1'))
    return {'ok': True, 'service': 'e-posyandu-api', 'database': 'postgresql'}


@app.get('/api/v1/collections/{resource_name}')
def list_collection(
    resource_name: str,
    filters: list[str] = Query(default=[] , alias='filter'),
    orders: list[str] = Query(default=[], alias='order'),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resource_name = validate_resource(resource_name)
    try:
        documents = list_documents(
            session,
            resource_name,
            [parse_filter(value) for value in filters],
            [parse_order(value) for value in orders],
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {'items': [document_response(resource_name, document) for document in documents]}


@app.post('/api/v1/collections/{resource_name}', status_code=201)
async def create_collection_document(
    resource_name: str,
    payload: DocumentPayload,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resource_name = validate_resource(resource_name)
    if not payload.id:
        raise HTTPException(status_code=422, detail='ID dokumen wajib diisi.')
    if get_document(session, resource_name, payload.id):
        raise HTTPException(status_code=409, detail='Data dengan ID tersebut sudah ada.')

    try:
        entity = create_entity(resource_name, payload.id, payload.data)
        session.add(entity)
        session.flush()
        entity = get_document(session, resource_name, payload.id)
        session.commit()
    except (ValueError, IntegrityError) as error:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(error)) from error

    await realtime_manager.broadcast_change(resource_name)
    return document_response(resource_name, entity)


@app.patch('/api/v1/collections/{resource_name}/{document_id}')
async def update_collection_document(
    resource_name: str,
    document_id: str,
    payload: DocumentPayload,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resource_name = validate_resource(resource_name)
    entity = get_document(session, resource_name, document_id)
    if not entity:
        raise HTTPException(status_code=404, detail='Data tidak ditemukan.')

    try:
        apply_entity(resource_name, entity, payload.data)
        session.flush()
        entity = get_document(session, resource_name, document_id)
        session.commit()
    except (ValueError, IntegrityError) as error:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(error)) from error

    await realtime_manager.broadcast_change(resource_name)
    return document_response(resource_name, entity)


@app.delete('/api/v1/collections/{resource_name}/{document_id}', status_code=204, response_class=Response)
async def delete_collection_document(
    resource_name: str,
    document_id: str,
    session: Session = Depends(get_session),
) -> Response:
    resource_name = validate_resource(resource_name)
    entity = get_document(session, resource_name, document_id)
    if not entity:
        raise HTTPException(status_code=404, detail='Data tidak ditemukan.')
    session.delete(entity)
    session.commit()
    await realtime_manager.broadcast_change(resource_name)
    return Response(status_code=204)


@app.websocket('/api/v1/realtime')
async def realtime(websocket: WebSocket) -> None:
    await realtime_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        realtime_manager.disconnect(websocket)
    except Exception:
        realtime_manager.disconnect(websocket)
