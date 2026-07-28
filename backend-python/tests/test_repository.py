import os
import unittest

os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://postgres:password@localhost:5432/postgres')

from sqlalchemy.orm import configure_mappers

from app.repository import create_entity, serialize


class RepositoryMappingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configure_mappers()

    def setUp(self):
        self.child = create_entity('children', 'child-1', {
            'nama': 'Bayi Uji',
            'nik': '3500000000000001',
            'tglLahir': '2025-01-01',
            'jk': 'L',
            'desa': 'Desa Gumukmas',
            'posyandu': 'SALAK 1',
            'hasKK': True,
            'hasNIK': True,
        })

    def test_child_is_serialized_with_legacy_field_names(self):
        data = serialize('children', self.child)
        self.assertEqual(data['nama'], 'Bayi Uji')
        self.assertEqual(data['tglLahir'], '2025-01-01')
        self.assertEqual(data['desa'], 'Desa Gumukmas')
        self.assertTrue(data['hasNIK'])

    def test_measurement_uses_native_columns_and_legacy_response(self):
        measurement = create_entity('measurements', 'measurement-1', {
            'childId': 'child-1',
            'tglUkur': '2025-02-01',
            'bb': '4.2',
            'tb': '54.5',
            'asi': 'Ya',
            'statusNaik': 'N',
        })
        measurement.child = self.child
        data = serialize('measurements', measurement)
        self.assertEqual(data['childName'], 'Bayi Uji')
        self.assertEqual(data['tglUkur'], '2025-02-01')
        self.assertEqual(data['statusNaik'], 'N')
        self.assertEqual(data['asi'], 'Ya')

    def test_mpasi_and_pmt_round_trip_to_existing_frontend_shape(self):
        mpasi = create_entity('mpasi_logs', 'mpasi-1', {
            'childId': 'child-1',
            'tglMonitoring': '2025-07-01',
            'asi': 'Ya',
            'makananPokok': ['Ya'],
            'telur': [],
        })
        mpasi.child = self.child
        self.assertEqual(serialize('mpasi_logs', mpasi)['makananPokok'], ['Ya'])
        self.assertEqual(serialize('mpasi_logs', mpasi)['telur'], [])

        program = create_entity('pmt_programs', 'pmt-1', {
            'childId': 'child-1',
            'category': 'Wasting',
            'jenisPmt': 'Lokal',
            'sumberAnggaran': 'APBD',
            'tglPemberian': '2025-07-01',
            'monitorings': {
                '1': {'tgl': '2025-07-08', 'bb': 5.1, 'tb': 60, 'days': [True, False]}
            },
        })
        program.child = self.child
        program_data = serialize('pmt_programs', program)
        self.assertEqual(program_data['monitorings'][1]['days'], [True, False, False, False, False, False, False])


if __name__ == '__main__':
    unittest.main()
