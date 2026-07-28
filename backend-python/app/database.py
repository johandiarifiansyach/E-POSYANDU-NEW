import os
from collections.abc import Generator

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

load_dotenv()


def database_url() -> str:
    url = os.getenv('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL belum diatur.')
    if url.startswith('postgres://'):
        return f'postgresql+psycopg://{url.removeprefix("postgres://")}'
    if url.startswith('postgresql://'):
        return f'postgresql+psycopg://{url.removeprefix("postgresql://")}'
    return url


engine = create_engine(database_url(), pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def create_schema_if_enabled() -> None:
    if os.getenv('AUTO_CREATE_SCHEMA', '').lower() in {'1', 'true', 'yes'}:
        Base.metadata.create_all(bind=engine)
