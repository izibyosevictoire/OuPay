import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft, ArrowRight, Loader2, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MerchantServiceError } from '@/services/merchantService'
import type { Merchant } from '@/types/merchant'
import {
  ONBOARDING_DEFAULT_VALUES,
  ONBOARDING_STEP_FIELDS,
  onboardingSchema,
  toCreateMerchantInput,
  type OnboardingFormValues,
} from '../merchantSchemas'
import { useCreateMerchant } from '../useMerchantQueries'
import { OnboardingStepper } from './OnboardingStepper'
import { OnboardingSuccess } from './OnboardingSuccess'
import { BusinessDetailsStep } from './steps/BusinessDetailsStep'
import { ContactStep } from './steps/ContactStep'
import { LocationStep } from './steps/LocationStep'
import { ReviewStep } from './steps/ReviewStep'

const STEP_HEADINGS = [
  { title: 'Business details', description: 'Tell us about the business you are registering.' },
  { title: 'Location', description: 'Where does the business operate?' },
  { title: 'Primary contact', description: 'Who should we contact about this business?' },
  { title: 'Review and confirm', description: 'Check everything before you submit.' },
] as const

const REVIEW_STEP_INDEX = STEP_HEADINGS.length - 1

export function OnboardingPage() {
  const [stepIndex, setStepIndex] = useState(0)
  const [registeredMerchant, setRegisteredMerchant] = useState<Merchant | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const isSubmittingRef = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const hasChangedStepRef = useRef(false)

  const createMerchant = useCreateMerchant()
  const form = useForm<OnboardingFormValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: ONBOARDING_DEFAULT_VALUES,
    mode: 'onTouched',
  })

  // Move focus to the new step's heading so keyboard and screen-reader users land in context.
  useEffect(() => {
    if (hasChangedStepRef.current) headingRef.current?.focus()
    hasChangedStepRef.current = true
  }, [stepIndex])

  if (registeredMerchant) return <OnboardingSuccess merchant={registeredMerchant} />

  const isReviewStep = stepIndex === REVIEW_STEP_INDEX
  const isSubmitting = createMerchant.isPending
  const heading = STEP_HEADINGS[stepIndex]!

  const goToNextStep = async () => {
    const fields = ONBOARDING_STEP_FIELDS[stepIndex]
    if (!fields) return
    const isStepValid = await form.trigger([...fields], { shouldFocus: true })
    if (isStepValid) setStepIndex(stepIndex + 1)
  }

  const goToPreviousStep = () => {
    setSubmissionError(null)
    setStepIndex(Math.max(0, stepIndex - 1))
  }

  const submitRegistration = async (values: OnboardingFormValues) => {
    if (isSubmittingRef.current) return
    isSubmittingRef.current = true
    setSubmissionError(null)
    try {
      setRegisteredMerchant(await createMerchant.mutateAsync(toCreateMerchantInput(values)))
    } catch (error) {
      if (error instanceof MerchantServiceError && error.code === 'duplicate_tin') {
        form.setError('tin', { message: error.message })
        setStepIndex(0)
      } else if (
        error instanceof MerchantServiceError &&
        error.code === 'duplicate_registration_number'
      ) {
        form.setError('registrationNumber', { message: error.message })
        setStepIndex(0)
      } else {
        setSubmissionError(
          error instanceof MerchantServiceError
            ? error.message
            : 'Something went wrong while submitting. Please try again.',
        )
      }
    } finally {
      isSubmittingRef.current = false
    }
  }

  return (
    <div className="space-y-5">
      <OnboardingStepper currentStepIndex={stepIndex} />
      <Card>
        <CardContent className="p-4 sm:p-6">
          <h1 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">
            {heading.title}
          </h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">{heading.description}</p>

          <FormProvider {...form}>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                if (isReviewStep) void form.handleSubmit(submitRegistration)()
                else void goToNextStep()
              }}
            >
              {stepIndex === 0 && <BusinessDetailsStep />}
              {stepIndex === 1 && <LocationStep />}
              {stepIndex === 2 && <ContactStep />}
              {isReviewStep && <ReviewStep onEdit={setStepIndex} />}

              {submissionError && (
                <p
                  role="alert"
                  className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  {submissionError}
                </p>
              )}

              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  onClick={goToPreviousStep}
                  disabled={stepIndex === 0 || isSubmitting}
                  className={stepIndex === 0 ? 'invisible' : undefined}
                >
                  <ArrowLeft aria-hidden="true" />
                  Back
                </Button>
                {isReviewStep ? (
                  <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Send aria-hidden="true" />
                    )}
                    {isSubmitting ? 'Submitting…' : 'Submit registration'}
                  </Button>
                ) : (
                  <Button type="submit">
                    Continue
                    <ArrowRight aria-hidden="true" />
                  </Button>
                )}
              </div>
            </form>
          </FormProvider>
        </CardContent>
      </Card>
    </div>
  )
}
