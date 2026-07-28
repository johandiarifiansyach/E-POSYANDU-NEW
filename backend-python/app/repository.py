from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Optional

from sqlalchemy import Select, asc, desc, select
from sqlalchemy.orm import Session, selectinload

from .models import ChangeLog, ChangeLogEntry, Child, Measurement, MpasiLog, PmtMonitoring, PmtProgram

RESOURCE_NAMES = {'children', 'measurements', 'mpasi_logs', 'pmt_programs', 'change_logs'}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def as_text(value: Any, default: str = '') -> str:
    if value is None:
        return default
    return str(value)


def as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {'1', 'true', 'ya', 'yes'}


def as_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ''):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def as_int(value: Any) -> Optional[int]:
    if value in (None, ''):
        return None
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def as_date(value: Any) -> Optional[date]:
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def as_datetime(value: Any) -> Optional[datetime]:
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_datetime(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def iso_date(value: Optional[date]) -> Optional[str]:
    return value.isoformat() if value else None


def number(value: Optional[Decimal]) -> Optional[float]:
    return float(value) if value is not None else None


def value_is_yes(value: Any) -> bool:
    if isinstance(value, list):
        return len(value) > 0
    return as_bool(value) or as_text(value).lower() == 'ya'


def assign_if_present(entity: Any, data: dict[str, Any], key: str, attribute: str, parser: Callable[[Any], Any] = lambda value: value) -> None:
    if key in data:
        setattr(entity, attribute, parser(data[key]))


def require_value(data: dict[str, Any], key: str, parser: Callable[[Any], Any] = lambda value: value) -> Any:
    value = parser(data.get(key))
    if value in (None, ''):
        raise ValueError(f'Kolom {key} wajib diisi.')
    return value


def child_data(child: Child) -> dict[str, Any]:
    return {
        'nama': child.name,
        'nik': child.national_id,
        'anakKe': child.child_order,
        'tglLahir': iso_date(child.birth_date) or child.birth_date_raw,
        'jk': child.sex,
        'noKK': child.family_card_number,
        'hasKK': child.has_family_card,
        'hasNIK': child.has_national_id,
        'usiaKehamilan': child.gestational_age_weeks,
        'bbLahir': number(child.birth_weight_kg),
        'pbLahir': number(child.birth_length_cm),
        'lkLahir': number(child.birth_head_circumference_cm),
        'bukuKIA': 'Ya' if child.has_maternal_child_book else 'Tidak',
        'bukuKIAKecil': 'Ya' if child.has_small_baby_book else 'Tidak',
        'imd': 'Ya' if child.early_breastfeeding_initiation else 'Tidak',
        'namaOrtu': child.parent_name,
        'nikOrtu': child.parent_national_id,
        'noHpOrtu': child.parent_phone,
        'alamat': child.address,
        'rt': child.rt,
        'rw': child.rw,
        'desa': child.village,
        'posyandu': child.posyandu,
        'currentBB': number(child.current_weight_kg),
        'currentTB': number(child.current_height_cm),
        'currentLILA': number(child.current_mid_upper_arm_circumference_cm),
        'currentLK': number(child.current_head_circumference_cm),
        'lastMeasurementDate': iso_date(child.last_measurement_date),
        'createdAt': iso_datetime(child.created_at),
        'createdBy': child.created_by,
        'updatedAt': iso_datetime(child.updated_at),
        'deletedAt': iso_datetime(child.deleted_at),
        'deleteReason': child.delete_reason,
        'deathDate': iso_date(child.death_date),
        'deathCause': child.death_cause,
        'deathLocation': child.death_location,
    }


def measurement_data(measurement: Measurement) -> dict[str, Any]:
    child = measurement.child
    return {
        'childId': measurement.legacy_child_id,
        'childName': measurement.legacy_child_name or (child.name if child else ''),
        'posyandu': measurement.legacy_posyandu or (child.posyandu if child else ''),
        'desa': measurement.legacy_village or (child.village if child else ''),
        'tglUkur': iso_date(measurement.measurement_date) or measurement.measurement_date_raw,
        'bb': number(measurement.weight_kg),
        'tb': number(measurement.height_cm),
        'lk': number(measurement.head_circumference_cm),
        'lila': number(measurement.mid_upper_arm_circumference_cm),
        'edema': measurement.edema,
        'kelasIbu': measurement.mother_class_attendance,
        'mbg': measurement.mbg,
        'vitA': measurement.vitamin_a,
        'asi': measurement.exclusive_breastfeeding,
        'caraUkur': measurement.measurement_method,
        'statusNaik': measurement.weight_gain_status,
        'ageInMonths': measurement.age_in_months,
        'createdAt': iso_datetime(measurement.created_at),
        'updatedAt': iso_datetime(measurement.updated_at),
    }


def mpasi_data(log: MpasiLog) -> dict[str, Any]:
    return {
        'childId': log.legacy_child_id,
        'childName': log.legacy_child_name or (log.child.name if log.child else ''),
        'tglMonitoring': iso_date(log.monitoring_date),
        'asi': log.breastfeeding,
        'makananPokok': ['Ya'] if log.staple_food else [],
        'kacang': ['Ya'] if log.legumes else [],
        'susu': ['Ya'] if log.dairy else [],
        'daging': ['Ya'] if log.meat else [],
        'telur': ['Ya'] if log.eggs else [],
        'sayurVitA': ['Ya'] if log.vitamin_a_fruit_vegetable else [],
        'sayurLain': ['Ya'] if log.other_fruit_vegetable else [],
        'intervensiGizi': log.nutrition_intervention,
        'createdAt': iso_datetime(log.created_at),
        'updatedAt': iso_datetime(log.updated_at),
    }


def pmt_data(program: PmtProgram) -> dict[str, Any]:
    monitorings: dict[int, dict[str, Any]] = {}
    for monitoring in program.monitorings:
        monitorings[monitoring.week_number] = {
            'tgl': iso_date(monitoring.monitoring_date),
            'bb': number(monitoring.weight_kg),
            'tb': number(monitoring.height_cm),
            'caraUkur': monitoring.measurement_method,
            'days': monitoring.consumed_days or [False] * 7,
            'pemantauanKesehatan': monitoring.health_monitoring,
            'tindakLanjut': monitoring.follow_up,
        }
    return {
        'childId': program.legacy_child_id,
        'childName': program.legacy_child_name or (program.child.name if program.child else ''),
        'category': program.category,
        'jenisPmt': program.pmt_type,
        'sumberAnggaran': program.funding_source,
        'mitra': program.partner or '',
        'mitraLain': program.other_partner or '',
        'siklusKe': program.cycle_number,
        'pmtSesuaiJuknis': program.follows_guidelines,
        'tglPemberian': iso_date(program.distribution_date),
        'status': program.status,
        'monitorings': monitorings,
        'createdAt': iso_datetime(program.created_at),
        'updatedAt': iso_datetime(program.updated_at),
    }


def change_log_data(log: ChangeLog) -> dict[str, Any]:
    return {
        'childId': log.child_id,
        'childName': log.child_name,
        'changes': [
            {'field': entry.field_name, 'oldValue': entry.old_value, 'newValue': entry.new_value}
            for entry in log.entries
        ],
        'changedBy': log.changed_by,
        'timestamp': iso_datetime(log.changed_at),
    }


def serialize(resource_name: str, entity: Any) -> dict[str, Any]:
    serializers = {
        'children': child_data,
        'measurements': measurement_data,
        'mpasi_logs': mpasi_data,
        'pmt_programs': pmt_data,
        'change_logs': change_log_data,
    }
    return serializers[resource_name](entity)


def apply_child(child: Child, data: dict[str, Any], creating: bool = False) -> None:
    if creating:
        child.name = require_value(data, 'nama', as_text)
        child.birth_date_raw = require_value(data, 'tglLahir', as_text)
        child.birth_date = as_date(child.birth_date_raw)
        child.sex = require_value(data, 'jk', as_text)
        child.village = require_value(data, 'desa', as_text)
        child.posyandu = require_value(data, 'posyandu', as_text)

    mappings = [
        ('nama', 'name', as_text), ('nik', 'national_id', as_text), ('anakKe', 'child_order', as_int),
        ('jk', 'sex', as_text), ('noKK', 'family_card_number', as_text),
        ('hasKK', 'has_family_card', as_bool), ('hasNIK', 'has_national_id', as_bool),
        ('usiaKehamilan', 'gestational_age_weeks', as_int), ('bbLahir', 'birth_weight_kg', as_decimal),
        ('pbLahir', 'birth_length_cm', as_decimal), ('lkLahir', 'birth_head_circumference_cm', as_decimal),
        ('bukuKIA', 'has_maternal_child_book', value_is_yes), ('bukuKIAKecil', 'has_small_baby_book', value_is_yes),
        ('imd', 'early_breastfeeding_initiation', value_is_yes), ('namaOrtu', 'parent_name', as_text),
        ('nikOrtu', 'parent_national_id', as_text), ('noHpOrtu', 'parent_phone', as_text),
        ('alamat', 'address', as_text), ('rt', 'rt', as_text), ('rw', 'rw', as_text),
        ('desa', 'village', as_text), ('posyandu', 'posyandu', as_text),
        ('currentBB', 'current_weight_kg', as_decimal), ('currentTB', 'current_height_cm', as_decimal),
        ('currentLILA', 'current_mid_upper_arm_circumference_cm', as_decimal),
        ('currentLK', 'current_head_circumference_cm', as_decimal),
        ('lastMeasurementDate', 'last_measurement_date', as_date), ('createdBy', 'created_by', as_text),
        ('deletedAt', 'deleted_at', as_datetime), ('deleteReason', 'delete_reason', lambda value: value if value is None else as_text(value)),
        ('deathDate', 'death_date', as_date), ('deathCause', 'death_cause', lambda value: value if value is None else as_text(value)),
        ('deathLocation', 'death_location', lambda value: value if value is None else as_text(value)),
    ]
    for key, attribute, parser in mappings:
        assign_if_present(child, data, key, attribute, parser)
    if 'tglLahir' in data:
        child.birth_date_raw = as_text(data['tglLahir'])
        child.birth_date = as_date(data['tglLahir'])
    if 'createdAt' in data:
        child.created_at = as_datetime(data['createdAt']) or now_utc()
    child.updated_at = as_datetime(data.get('updatedAt')) or now_utc()


def apply_measurement(measurement: Measurement, data: dict[str, Any], creating: bool = False) -> None:
    if creating:
        measurement.legacy_child_id = require_value(data, 'childId', as_text)
        measurement.child_id = measurement.legacy_child_id
        measurement.legacy_child_name = as_text(data.get('childName'))
        measurement.legacy_village = as_text(data.get('desa'))
        measurement.legacy_posyandu = as_text(data.get('posyandu'))
        measurement.measurement_date_raw = require_value(data, 'tglUkur', as_text)
        measurement.measurement_date = as_date(measurement.measurement_date_raw)
    mappings = [
        ('childName', 'legacy_child_name', as_text), ('desa', 'legacy_village', as_text),
        ('posyandu', 'legacy_posyandu', as_text), ('bb', 'weight_kg', as_decimal),
        ('tb', 'height_cm', as_decimal), ('lk', 'head_circumference_cm', as_decimal), ('lila', 'mid_upper_arm_circumference_cm', as_decimal),
        ('edema', 'edema', as_text), ('kelasIbu', 'mother_class_attendance', as_text), ('mbg', 'mbg', as_text),
        ('vitA', 'vitamin_a', as_text), ('asi', 'exclusive_breastfeeding', as_text),
        ('caraUkur', 'measurement_method', as_text), ('statusNaik', 'weight_gain_status', as_text),
        ('ageInMonths', 'age_in_months', as_int),
    ]
    for key, attribute, parser in mappings:
        assign_if_present(measurement, data, key, attribute, parser)
    if 'childId' in data:
        measurement.legacy_child_id = as_text(data['childId'])
        measurement.child_id = measurement.legacy_child_id
    if 'tglUkur' in data:
        measurement.measurement_date_raw = as_text(data['tglUkur'])
        measurement.measurement_date = as_date(data['tglUkur'])
    if 'createdAt' in data:
        measurement.created_at = as_datetime(data['createdAt']) or now_utc()
    measurement.updated_at = as_datetime(data.get('updatedAt')) or now_utc()


def apply_mpasi(log: MpasiLog, data: dict[str, Any], creating: bool = False) -> None:
    if creating:
        log.legacy_child_id = require_value(data, 'childId', as_text)
        log.child_id = log.legacy_child_id
        log.legacy_child_name = as_text(data.get('childName'))
        log.monitoring_date = require_value(data, 'tglMonitoring', as_date)
    mappings = [
        ('childName', 'legacy_child_name', as_text), ('tglMonitoring', 'monitoring_date', as_date),
        ('asi', 'breastfeeding', as_text), ('makananPokok', 'staple_food', value_is_yes),
        ('kacang', 'legumes', value_is_yes), ('susu', 'dairy', value_is_yes), ('daging', 'meat', value_is_yes),
        ('telur', 'eggs', value_is_yes), ('sayurVitA', 'vitamin_a_fruit_vegetable', value_is_yes),
        ('sayurLain', 'other_fruit_vegetable', value_is_yes), ('intervensiGizi', 'nutrition_intervention', as_text),
    ]
    for key, attribute, parser in mappings:
        assign_if_present(log, data, key, attribute, parser)
    if 'childId' in data:
        log.legacy_child_id = as_text(data['childId'])
        log.child_id = log.legacy_child_id
    if 'createdAt' in data:
        log.created_at = as_datetime(data['createdAt']) or now_utc()
    log.updated_at = as_datetime(data.get('updatedAt')) or now_utc()


def apply_monitorings(program: PmtProgram, data: dict[str, Any]) -> None:
    if 'monitorings' not in data or not isinstance(data['monitorings'], dict):
        return
    by_week = {item.week_number: item for item in program.monitorings}
    for raw_week, entry in data['monitorings'].items():
        week_number = as_int(raw_week)
        if not week_number or not isinstance(entry, dict):
            continue
        monitoring = by_week.get(week_number)
        if not monitoring:
            monitoring = PmtMonitoring(program_id=program.id, week_number=week_number, consumed_days=[False] * 7)
            program.monitorings.append(monitoring)
        monitoring.monitoring_date = as_date(entry.get('tgl'))
        monitoring.weight_kg = as_decimal(entry.get('bb'))
        monitoring.height_cm = as_decimal(entry.get('tb'))
        monitoring.measurement_method = as_text(entry.get('caraUkur'))
        days = entry.get('days')
        if isinstance(days, list):
            monitoring.consumed_days = [as_bool(day) for day in (days[:7] + [False] * 7)[:7]]
        monitoring.health_monitoring = as_text(entry.get('pemantauanKesehatan'), 'Ada')
        monitoring.follow_up = as_text(entry.get('tindakLanjut'), 'Dilanjutkan')
        monitoring.updated_at = now_utc()


def apply_pmt(program: PmtProgram, data: dict[str, Any], creating: bool = False) -> None:
    if creating:
        program.legacy_child_id = require_value(data, 'childId', as_text)
        program.child_id = program.legacy_child_id
        program.legacy_child_name = as_text(data.get('childName'))
        program.category = require_value(data, 'category', as_text)
        program.pmt_type = require_value(data, 'jenisPmt', as_text)
        program.funding_source = require_value(data, 'sumberAnggaran', as_text)
        program.distribution_date = require_value(data, 'tglPemberian', as_date)
    mappings = [
        ('childName', 'legacy_child_name', as_text), ('category', 'category', as_text), ('jenisPmt', 'pmt_type', as_text),
        ('sumberAnggaran', 'funding_source', as_text), ('mitra', 'partner', lambda value: value if value is None else as_text(value)),
        ('mitraLain', 'other_partner', lambda value: value if value is None else as_text(value)),
        ('siklusKe', 'cycle_number', as_int), ('pmtSesuaiJuknis', 'follows_guidelines', as_text),
        ('tglPemberian', 'distribution_date', as_date), ('status', 'status', as_text),
    ]
    for key, attribute, parser in mappings:
        assign_if_present(program, data, key, attribute, parser)
    if 'childId' in data:
        program.legacy_child_id = as_text(data['childId'])
        program.child_id = program.legacy_child_id
    if 'createdAt' in data:
        program.created_at = as_datetime(data['createdAt']) or now_utc()
    program.updated_at = as_datetime(data.get('updatedAt')) or now_utc()
    apply_monitorings(program, data)


def apply_change_log(log: ChangeLog, data: dict[str, Any], creating: bool = False) -> None:
    if creating:
        log.child_id = data.get('childId') or None
        log.legacy_child_id = data.get('childId') or None
        log.child_name = as_text(data.get('childName'))
        log.changed_by = as_text(data.get('changedBy'))
        log.changed_at = as_datetime(data.get('timestamp')) or now_utc()
    assign_if_present(log, data, 'childId', 'child_id', lambda value: value or None)
    assign_if_present(log, data, 'childId', 'legacy_child_id', lambda value: value or None)
    assign_if_present(log, data, 'childName', 'child_name', as_text)
    assign_if_present(log, data, 'changedBy', 'changed_by', as_text)
    assign_if_present(log, data, 'timestamp', 'changed_at', lambda value: as_datetime(value) or now_utc())
    if 'changes' in data and isinstance(data['changes'], list):
        log.entries.clear()
        for entry in data['changes']:
            if not isinstance(entry, dict):
                continue
            log.entries.append(ChangeLogEntry(
                field_name=as_text(entry.get('field')),
                old_value=entry.get('oldValue'),
                new_value=entry.get('newValue'),
            ))


def model_for(resource_name: str) -> Any:
    return {
        'children': Child,
        'measurements': Measurement,
        'mpasi_logs': MpasiLog,
        'pmt_programs': PmtProgram,
        'change_logs': ChangeLog,
    }[resource_name]


def create_entity(resource_name: str, document_id: str, data: dict[str, Any]) -> Any:
    if resource_name == 'children':
        entity = Child(id=document_id)
        apply_child(entity, data, True)
    elif resource_name == 'measurements':
        entity = Measurement(id=document_id)
        apply_measurement(entity, data, True)
    elif resource_name == 'mpasi_logs':
        entity = MpasiLog(id=document_id)
        apply_mpasi(entity, data, True)
    elif resource_name == 'pmt_programs':
        entity = PmtProgram(id=document_id)
        apply_pmt(entity, data, True)
    else:
        entity = ChangeLog(id=document_id)
        apply_change_log(entity, data, True)
    return entity


def apply_entity(resource_name: str, entity: Any, data: dict[str, Any]) -> None:
    if resource_name == 'children':
        apply_child(entity, data)
    elif resource_name == 'measurements':
        apply_measurement(entity, data)
    elif resource_name == 'mpasi_logs':
        apply_mpasi(entity, data)
    elif resource_name == 'pmt_programs':
        apply_pmt(entity, data)
    else:
        apply_change_log(entity, data)


def options_for(resource_name: str) -> list[Any]:
    if resource_name == 'pmt_programs':
        return [selectinload(PmtProgram.monitorings)]
    if resource_name == 'change_logs':
        return [selectinload(ChangeLog.entries)]
    return []


def get_document(session: Session, resource_name: str, document_id: str) -> Any:
    model = model_for(resource_name)
    statement = select(model).where(model.id == document_id).options(*options_for(resource_name))
    return session.scalar(statement)


def field_for(resource_name: str, field_name: str) -> tuple[Any, bool, Callable[[Any], Any]]:
    maps: dict[str, dict[str, tuple[Any, bool, Callable[[Any], Any]]]] = {
        'children': {
            'desa': (Child.village, False, as_text), 'posyandu': (Child.posyandu, False, as_text),
            'tglLahir': (Child.birth_date, False, as_date), 'createdAt': (Child.created_at, False, as_datetime),
            'deletedAt': (Child.deleted_at, False, as_datetime), 'nama': (Child.name, False, as_text),
        },
        'measurements': {
            'childId': (Measurement.legacy_child_id, False, as_text), 'tglUkur': (Measurement.measurement_date, False, as_date),
            'desa': (Measurement.legacy_village, False, as_text), 'posyandu': (Measurement.legacy_posyandu, False, as_text),
            'createdAt': (Measurement.created_at, False, as_datetime),
        },
        'mpasi_logs': {
            'childId': (MpasiLog.legacy_child_id, False, as_text), 'tglMonitoring': (MpasiLog.monitoring_date, False, as_date),
            'createdAt': (MpasiLog.created_at, False, as_datetime),
        },
        'pmt_programs': {
            'childId': (PmtProgram.legacy_child_id, False, as_text), 'status': (PmtProgram.status, False, as_text),
            'createdAt': (PmtProgram.created_at, False, as_datetime),
        },
        'change_logs': {
            'timestamp': (ChangeLog.changed_at, False, as_datetime), 'childId': (ChangeLog.child_id, False, as_text),
        },
    }
    try:
        return maps[resource_name][field_name]
    except KeyError as error:
        raise ValueError(f'Filter atau urutan {field_name} tidak didukung.') from error


def list_documents(
    session: Session,
    resource_name: str,
    filters: list[tuple[str, str, str]],
    orders: list[tuple[str, str]],
) -> list[Any]:
    model = model_for(resource_name)
    statement: Select[Any] = select(model).options(*options_for(resource_name))
    needs_child_join = False
    parsed_filters: list[tuple[Any, str, Any]] = []
    for field_name, operator, raw_value in filters:
        field, needs_join, parser = field_for(resource_name, field_name)
        value = parser(raw_value)
        if value is None and operator != '==':
            raise ValueError(f'Nilai filter {field_name} tidak valid.')
        parsed_filters.append((field, operator, value))
        needs_child_join = needs_child_join or needs_join

    parsed_orders: list[tuple[Any, str]] = []
    for field_name, direction in orders:
        field, needs_join, _ = field_for(resource_name, field_name)
        parsed_orders.append((field, direction))
        needs_child_join = needs_child_join or needs_join

    if needs_child_join and resource_name == 'measurements':
        statement = statement.join(Measurement.child)

    for field, operator, value in parsed_filters:
        if operator == '==':
            statement = statement.where(field.is_(None) if value is None else field == value)
        elif operator == '>=':
            statement = statement.where(field >= value)
        elif operator == '<=':
            statement = statement.where(field <= value)
        else:
            raise ValueError('Operator filter tidak didukung.')

    for field, direction in parsed_orders:
        statement = statement.order_by(desc(field) if direction == 'desc' else asc(field))

    return list(session.scalars(statement).unique().all())
