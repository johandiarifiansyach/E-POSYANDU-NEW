"""Compare legacy documents totals with their native PostgreSQL counterparts."""

from __future__ import annotations

import sys

from sqlalchemy import text

from .database import SessionLocal

TABLES = {
    'children': 'children',
    'measurements': 'measurements',
    'mpasi_logs': 'mpasi_logs',
    'pmt_programs': 'pmt_programs',
    'change_logs': 'change_logs',
}


def verify() -> bool:
    valid = True
    with SessionLocal() as session:
        for legacy_name, native_name in TABLES.items():
            legacy_count = session.scalar(
                text('select count(*) from public.documents where table_name = :table_name'),
                {'table_name': legacy_name},
            )
            native_count = session.scalar(text(f'select count(*) from public.{native_name}'))
            matches = legacy_count == native_count
            valid = valid and matches
            marker = 'OK' if matches else 'TIDAK SAMA'
            print(f'{legacy_name}: legacy={legacy_count} native={native_count} [{marker}]')
    return valid


if __name__ == '__main__':
    if not verify():
        raise SystemExit(1)
