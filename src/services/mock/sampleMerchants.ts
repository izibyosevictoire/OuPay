// SAMPLE DATA ONLY. Not real businesses and not bank-approved.
import type { Merchant } from '@/types/merchant'

export const SAMPLE_USER_ID = 'usr-sample-001'
export const SAMPLE_MERCHANT_ID = 'mrc-sample-001'
export const SAMPLE_SECOND_MERCHANT_ID = 'mrc-sample-002'

export const SAMPLE_MERCHANTS: Merchant[] = [
  {
    id: SAMPLE_MERCHANT_ID,
    ownerUserId: SAMPLE_USER_ID,
    legalName: 'Sample Business Ltd',
    tradingName: 'Sample Shop',
    businessType: 'registered_company',
    status: 'pending_verification',
    registration: { registrationNumber: 'SMP-RDB-000123', tin: '100000001' },
    location: {
      country: 'RW',
      province: 'Kigali City',
      district: 'Gasabo',
      sector: 'Remera',
      physicalAddress: 'KG 11 Ave, near Sample Plaza',
    },
    contact: {
      fullName: 'Sample Owner',
      email: 'owner@sample-business.example',
      phoneNumber: '+250788000001',
    },
    bankingConfiguration: { status: 'not_configured' },
    createdAt: '2026-10-01T09:00:00+02:00',
    updatedAt: '2026-10-01T09:00:00+02:00',
  },
  {
    id: SAMPLE_SECOND_MERCHANT_ID,
    ownerUserId: 'usr-sample-other-owner',
    legalName: 'Sample Corner Cafe',
    businessType: 'sole_proprietor',
    status: 'pending_verification',
    registration: {},
    location: {
      country: 'RW',
      province: 'Kigali City',
      district: 'Nyarugenge',
      sector: 'Nyamirambo',
      physicalAddress: 'Nyamirambo main road',
    },
    contact: {
      fullName: 'Sample Cafe Owner',
      email: 'hello@sample-cafe.example',
      phoneNumber: '+250788000009',
    },
    bankingConfiguration: { status: 'not_configured' },
    createdAt: '2026-10-03T09:00:00+02:00',
    updatedAt: '2026-10-03T09:00:00+02:00',
  },
]
