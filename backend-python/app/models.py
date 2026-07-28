from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Child(Base):
    __tablename__ = 'children'

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    national_id: Mapped[str] = mapped_column(Text, nullable=False, default='')
    child_order: Mapped[Optional[int]] = mapped_column(SmallInteger)
    birth_date: Mapped[Optional[date]] = mapped_column(Date)
    birth_date_raw: Mapped[str] = mapped_column(Text, nullable=False)
    sex: Mapped[str] = mapped_column(String(1), nullable=False)
    family_card_number: Mapped[str] = mapped_column(Text, nullable=False, default='')
    has_family_card: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_national_id: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    gestational_age_weeks: Mapped[Optional[int]] = mapped_column(SmallInteger)
    birth_weight_kg: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    birth_length_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    birth_head_circumference_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    has_maternal_child_book: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_small_baby_book: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    early_breastfeeding_initiation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parent_name: Mapped[str] = mapped_column(Text, nullable=False, default='')
    parent_national_id: Mapped[str] = mapped_column(Text, nullable=False, default='')
    parent_phone: Mapped[str] = mapped_column(Text, nullable=False, default='')
    address: Mapped[str] = mapped_column(Text, nullable=False, default='')
    rt: Mapped[str] = mapped_column(String(8), nullable=False, default='')
    rw: Mapped[str] = mapped_column(String(8), nullable=False, default='')
    village: Mapped[str] = mapped_column(Text, nullable=False)
    posyandu: Mapped[str] = mapped_column(Text, nullable=False)
    current_weight_kg: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    current_height_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    current_mid_upper_arm_circumference_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    current_head_circumference_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    last_measurement_date: Mapped[Optional[date]] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    delete_reason: Mapped[Optional[str]] = mapped_column(Text)
    death_date: Mapped[Optional[date]] = mapped_column(Date)
    death_cause: Mapped[Optional[str]] = mapped_column(Text)
    death_location: Mapped[Optional[str]] = mapped_column(Text)

    measurements: Mapped[list[Measurement]] = relationship(back_populates='child', cascade='all, delete-orphan')
    mpasi_logs: Mapped[list[MpasiLog]] = relationship(back_populates='child', cascade='all, delete-orphan')
    pmt_programs: Mapped[list[PmtProgram]] = relationship(back_populates='child', cascade='all, delete-orphan')


class Measurement(Base):
    __tablename__ = 'measurements'

    id: Mapped[str] = mapped_column(String, primary_key=True)
    child_id: Mapped[Optional[str]] = mapped_column(ForeignKey('children.id', ondelete='SET NULL'))
    legacy_child_id: Mapped[str] = mapped_column(String, nullable=False)
    legacy_child_name: Mapped[str] = mapped_column(Text, nullable=False, default='')
    legacy_village: Mapped[str] = mapped_column(Text, nullable=False, default='')
    legacy_posyandu: Mapped[str] = mapped_column(Text, nullable=False, default='')
    measurement_date: Mapped[Optional[date]] = mapped_column(Date)
    measurement_date_raw: Mapped[str] = mapped_column(Text, nullable=False)
    weight_kg: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    height_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    head_circumference_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    mid_upper_arm_circumference_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    edema: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    mother_class_attendance: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    mbg: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    vitamin_a: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    exclusive_breastfeeding: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    measurement_method: Mapped[str] = mapped_column(Text, nullable=False, default='')
    weight_gain_status: Mapped[str] = mapped_column(String(1), nullable=False, default='B')
    age_in_months: Mapped[Optional[int]] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    child: Mapped[Optional[Child]] = relationship(back_populates='measurements')


class MpasiLog(Base):
    __tablename__ = 'mpasi_logs'

    id: Mapped[str] = mapped_column(String, primary_key=True)
    child_id: Mapped[Optional[str]] = mapped_column(ForeignKey('children.id', ondelete='SET NULL'))
    legacy_child_id: Mapped[str] = mapped_column(String, nullable=False)
    legacy_child_name: Mapped[str] = mapped_column(Text, nullable=False, default='')
    monitoring_date: Mapped[date] = mapped_column(Date, nullable=False)
    breastfeeding: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    staple_food: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    legumes: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    dairy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    meat: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    eggs: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    vitamin_a_fruit_vegetable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    other_fruit_vegetable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    nutrition_intervention: Mapped[str] = mapped_column(Text, nullable=False, default='Tidak')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    child: Mapped[Optional[Child]] = relationship(back_populates='mpasi_logs')


class PmtProgram(Base):
    __tablename__ = 'pmt_programs'

    id: Mapped[str] = mapped_column(String, primary_key=True)
    child_id: Mapped[Optional[str]] = mapped_column(ForeignKey('children.id', ondelete='SET NULL'))
    legacy_child_id: Mapped[str] = mapped_column(String, nullable=False)
    legacy_child_name: Mapped[str] = mapped_column(Text, nullable=False, default='')
    category: Mapped[str] = mapped_column(Text, nullable=False)
    pmt_type: Mapped[str] = mapped_column(Text, nullable=False)
    funding_source: Mapped[str] = mapped_column(Text, nullable=False)
    partner: Mapped[Optional[str]] = mapped_column(Text)
    other_partner: Mapped[Optional[str]] = mapped_column(Text)
    cycle_number: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    follows_guidelines: Mapped[str] = mapped_column(Text, nullable=False, default='Ya')
    distribution_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default='Aktif')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    child: Mapped[Optional[Child]] = relationship(back_populates='pmt_programs')
    monitorings: Mapped[list[PmtMonitoring]] = relationship(back_populates='program', cascade='all, delete-orphan')


class PmtMonitoring(Base):
    __tablename__ = 'pmt_monitorings'

    program_id: Mapped[str] = mapped_column(ForeignKey('pmt_programs.id', ondelete='CASCADE'), primary_key=True)
    week_number: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    monitoring_date: Mapped[Optional[date]] = mapped_column(Date)
    weight_kg: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    height_cm: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 1))
    measurement_method: Mapped[str] = mapped_column(Text, nullable=False, default='')
    consumed_days: Mapped[list[bool]] = mapped_column(ARRAY(Boolean), nullable=False)
    health_monitoring: Mapped[str] = mapped_column(Text, nullable=False, default='Ada')
    follow_up: Mapped[str] = mapped_column(Text, nullable=False, default='Dilanjutkan')
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    program: Mapped[PmtProgram] = relationship(back_populates='monitorings')


class ChangeLog(Base):
    __tablename__ = 'change_logs'

    id: Mapped[str] = mapped_column(String, primary_key=True)
    child_id: Mapped[Optional[str]] = mapped_column(ForeignKey('children.id', ondelete='SET NULL'))
    legacy_child_id: Mapped[Optional[str]] = mapped_column(String)
    child_name: Mapped[str] = mapped_column(Text, nullable=False, default='')
    changed_by: Mapped[str] = mapped_column(Text, nullable=False, default='')
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    entries: Mapped[list[ChangeLogEntry]] = relationship(back_populates='change_log', cascade='all, delete-orphan')


class ChangeLogEntry(Base):
    __tablename__ = 'change_log_entries'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    change_log_id: Mapped[str] = mapped_column(ForeignKey('change_logs.id', ondelete='CASCADE'), nullable=False)
    field_name: Mapped[str] = mapped_column(Text, nullable=False)
    old_value: Mapped[Optional[Any]] = mapped_column(JSONB)
    new_value: Mapped[Optional[Any]] = mapped_column(JSONB)

    change_log: Mapped[ChangeLog] = relationship(back_populates='entries')
