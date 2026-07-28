"""Copy the existing Supabase documents JSONB records into native PostgreSQL tables."""

from __future__ import annotations

import sys
from collections import Counter
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Child
from .repository import (
    RESOURCE_NAMES,
    apply_entity,
    create_entity,
    get_document,
)

MIGRATION_ORDER = ['children', 'measurements', 'mpasi_logs', 'pmt_programs', 'change_logs']


def legacy_rows(session: Session, resource_name: str) -> list[tuple[str, dict[str, Any]]]:
    rows = session.execute(
        text('select id, data from public.documents where table_name = :table_name order by id'),
        {'table_name': resource_name},
    )
    return [(str(row.id), dict(row.data or {})) for row in rows]


def has_child(session: Session, child_id: Optional[str]) -> bool:
    return bool(child_id and session.get(Child, child_id))


def migrate_document(session: Session, resource_name: str, document_id: str, data: dict[str, Any]) -> None:
    payload = dict(data)
    child_id = payload.get('childId')
    orphaned_child = resource_name != 'children' and not has_child(session, child_id)

    entity = get_document(session, resource_name, document_id)
    if entity:
        apply_entity(resource_name, entity, payload)
    else:
        entity = create_entity(resource_name, document_id, payload)
        session.add(entity)

    if resource_name in {'measurements', 'mpasi_logs', 'pmt_programs'} and orphaned_child:
        entity.child_id = None

    if resource_name == 'change_logs' and orphaned_child:
        entity.child_id = None
        entity.legacy_child_id = str(child_id) if child_id else None


def migrate() -> Counter[str]:
    counts: Counter[str] = Counter()
    with SessionLocal.begin() as session:
        for resource_name in MIGRATION_ORDER:
            if resource_name not in RESOURCE_NAMES:
                continue
            rows = legacy_rows(session, resource_name)
            print(f'Memigrasikan {resource_name}: {len(rows)} data')
            for document_id, data in rows:
                migrate_document(session, resource_name, document_id, data)
                counts[resource_name] += 1
            session.flush()
    return counts


if __name__ == '__main__':
    try:
        result = migrate()
    except Exception as error:
        print(f'Migrasi dibatalkan. Tidak ada data yang di-commit: {error}', file=sys.stderr)
        raise SystemExit(1)
    print('Migrasi PostgreSQL native selesai.')
    for resource_name in MIGRATION_ORDER:
        print(f'- {resource_name}: {result[resource_name]}')
