export interface RwandaProvince {
  name: string
  districts: string[]
}

export const RWANDA_PROVINCES: RwandaProvince[] = [
  { name: 'Kigali City', districts: ['Gasabo', 'Kicukiro', 'Nyarugenge'] },
  { name: 'Northern Province', districts: ['Burera', 'Gakenke', 'Gicumbi', 'Musanze', 'Rulindo'] },
  {
    name: 'Southern Province',
    districts: [
      'Gisagara',
      'Huye',
      'Kamonyi',
      'Muhanga',
      'Nyamagabe',
      'Nyanza',
      'Nyaruguru',
      'Ruhango',
    ],
  },
  {
    name: 'Eastern Province',
    districts: ['Bugesera', 'Gatsibo', 'Kayonza', 'Kirehe', 'Ngoma', 'Nyagatare', 'Rwamagana'],
  },
  {
    name: 'Western Province',
    districts: ['Karongi', 'Ngororero', 'Nyabihu', 'Nyamasheke', 'Rubavu', 'Rusizi', 'Rutsiro'],
  },
]

/**
 * Sector lists are bundled for Kigali's three districts only. Other districts fall
 * back to free-text entry until the full administrative dataset comes from the backend.
 */
export const SECTORS_BY_DISTRICT: Record<string, string[]> = {
  Gasabo: [
    'Bumbogo',
    'Gatsata',
    'Gikomero',
    'Gisozi',
    'Jabana',
    'Jali',
    'Kacyiru',
    'Kimihurura',
    'Kimironko',
    'Kinyinya',
    'Ndera',
    'Nduba',
    'Remera',
    'Rusororo',
    'Rutunga',
  ],
  Kicukiro: [
    'Gahanga',
    'Gatenga',
    'Gikondo',
    'Kagarama',
    'Kanombe',
    'Kicukiro',
    'Kigarama',
    'Masaka',
    'Niboye',
    'Nyarugunga',
  ],
  Nyarugenge: [
    'Gitega',
    'Kanyinya',
    'Kigali',
    'Kimisagara',
    'Mageragere',
    'Muhima',
    'Nyakabanda',
    'Nyamirambo',
    'Nyarugenge',
    'Rwezamenyo',
  ],
}

export const getDistrictsForProvince = (provinceName: string) =>
  RWANDA_PROVINCES.find((province) => province.name === provinceName)?.districts ?? []

export const getSectorsForDistrict = (districtName: string): string[] | undefined =>
  SECTORS_BY_DISTRICT[districtName]
