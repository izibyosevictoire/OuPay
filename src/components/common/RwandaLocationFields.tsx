import { useWatch, type UseFormReturn } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import { Input, Select } from '@/components/ui/input'
import {
  getDistrictsForProvince,
  getSectorsForDistrict,
  RWANDA_PROVINCES,
} from '@/constants/rwandaGeography'

/** The three fields this selector reads and writes; any form containing them can use it. */
export interface RwandaLocationFieldValues {
  province: string
  district: string
  sector: string
}

/**
 * Province, district and sector, where each choice narrows the next. Changing a parent
 * clears its children so an inconsistent combination can never be submitted.
 */
export function RwandaLocationFields({ form }: { form: UseFormReturn<RwandaLocationFieldValues> }) {
  const {
    register,
    control,
    setValue,
    formState: { errors },
  } = form
  const province = useWatch({ control, name: 'province' })
  const district = useWatch({ control, name: 'district' })
  const districts = getDistrictsForProvince(province)
  const sectors = getSectorsForDistrict(district)

  return (
    <>
      <FormField label="Province" required error={errors.province?.message}>
        {(field) => (
          <Select
            {...field}
            {...register('province', {
              onChange: () => {
                setValue('district', '')
                setValue('sector', '')
              },
            })}
          >
            <option value="">Select a province</option>
            {RWANDA_PROVINCES.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="District" required error={errors.district?.message}>
        {(field) => (
          <Select
            {...field}
            disabled={!province}
            {...register('district', { onChange: () => setValue('sector', '') })}
          >
            <option value="">{province ? 'Select a district' : 'Choose a province first'}</option>
            {districts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label="Sector"
        required
        error={errors.sector?.message}
        hint={district && !sectors ? 'Type the name of the sector.' : undefined}
      >
        {(field) =>
          sectors ? (
            <Select {...field} {...register('sector')}>
              <option value="">Select a sector</option>
              {sectors.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          ) : (
            <Input {...field} disabled={!district} {...register('sector')} />
          )
        }
      </FormField>
    </>
  )
}
