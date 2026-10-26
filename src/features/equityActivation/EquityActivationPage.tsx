import { Check, Info } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { cn } from '@/lib/utils'
import { API_MODE } from '@/services/http/apiConfig'
import type { KycApplication, KycOptions } from '@/types/kyc'
import { ConsentStep } from './ConsentStep'
import { DocumentsStep } from './DocumentsStep'
import { FieldsStep } from './FieldsStep'
import {
  useKycApplication,
  useKycOptions,
  useRecordConsent,
  useSaveAnswers,
  useStartApplication,
  useSubmitApplication,
} from './kycQueries'
import { fieldProblem, missingRequired } from './kycRules'
import {
  forgetStartOperation,
  forgetSubmission,
  startOperationId,
  submissionId,
} from './kycSession'
import { StatusStep } from './StatusStep'

const STEPS = [
  'Business information',
  'Representative information',
  'Equity account information',
  'Document requirements',
  'Consent and review',
  'Application status',
] as const
const SECTION_OF_STEP = ['BUSINESS', 'REPRESENTATIVE', 'BANK'] as const
const STATUS_STEP = STEPS.length - 1

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export function EquityActivationPage() {
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  // Keyed by business and person: switching either never shows another's application.
  const scope = `${merchantId}.${user?.id ?? 'anonymous'}`
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Equity activation"
        description="Prepare the information Equity Bank needs to open a business account for collections."
      />
      {API_MODE !== 'http' && (
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-xs text-info"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            <strong className="font-semibold">Demo mode.</strong> Nothing is sent anywhere, and no
            bank decision can appear here.
          </p>
        </div>
      )}
      <Body key={scope} scope={scope} />
    </div>
  )
}

function Body({ scope }: { scope: string }) {
  const options = useKycOptions()
  return (
    <QueryBoundary
      query={options}
      loadingFallback={<Skeleton className="h-72 w-full" />}
      errorMessage="Equity activation could not be loaded."
    >
      {(data) =>
        data.current ? <Existing options={data} /> : <Intro options={data} scope={scope} />
      }
    </QueryBoundary>
  )
}

function Existing({ options }: { options: KycOptions }) {
  const application = useKycApplication(options.current?.id)
  return (
    <QueryBoundary
      query={application}
      loadingFallback={<Skeleton className="h-72 w-full" />}
      errorMessage="Your application could not be loaded."
    >
      {(data) => <Wizard options={options} application={data} />}
    </QueryBoundary>
  )
}

function Intro({ options, scope }: { options: KycOptions; scope: string }) {
  const start = useStartApplication()
  const [failure, setFailure] = useState<string | null>(null)
  const begin = async () => {
    setFailure(null)
    try {
      // The same id until it succeeds: a retry after a lost answer finds the application the first try made.
      await start.mutateAsync(startOperationId(scope))
      forgetStartOperation(scope)
    } catch (caught) {
      setFailure(messageOf(caught, 'The application could not be started.'))
    }
  }
  return (
    <Card>
      <CardContent className="space-y-4 p-4 text-sm sm:p-6">
        <h2 className="text-lg font-semibold">Prepare your Equity application</h2>
        <p>
          OuPay will ask for your business details, a representative, and whether you already have
          an Equity account. Details OuPay already has from your registration are filled in for you.
          You can save a draft and come back.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{options.requirementSet.definition.note}</li>
          <li>
            {options.storage.documentUploadAvailable
              ? 'You can upload the documents Equity asks for.'
              : 'Documents cannot be uploaded yet. OuPay has no secure storage for them, so none are received.'}
          </li>
          <li>
            {options.storage.submissionToEquityAvailable
              ? 'OuPay will send your application to Equity.'
              : 'Submitting gives your application to OuPay for review. OuPay does not send it to Equity yet, and nothing here means Equity has approved anything.'}
          </li>
          <li>OuPay never asks for an online banking password, PIN or one-time code.</li>
        </ul>
        {options.linkedAccounts.length > 0 && (
          <section aria-labelledby="linked-heading">
            <h3 id="linked-heading" className="text-sm font-semibold">
              Accounts already linked to your business
            </h3>
            <ul className="mt-1 list-disc pl-5">
              {options.linkedAccounts.map((account) => (
                <li key={`${account.label}-${account.maskedAccount}`}>
                  {account.label} ({account.maskedAccount})
                  {account.simulated ? ' — demo account' : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
        {failure && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-danger">
            {failure}
          </p>
        )}
        <Button type="button" onClick={() => void begin()} disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Start application'}
        </Button>
      </CardContent>
    </Card>
  )
}

function Stepper({
  step,
  limit,
  onGo,
}: {
  step: number
  limit: number
  onGo: (index: number) => void
}) {
  return (
    <nav aria-label="Application steps">
      <p className="mb-3 text-sm text-muted-foreground sm:hidden">
        Step {step + 1} of {STEPS.length}:{' '}
        <span className="font-medium text-foreground">{STEPS[step]}</span>
      </p>
      <ol className="hidden flex-wrap gap-2 sm:flex">
        {STEPS.map((title, index) => {
          const reachable = index <= limit
          return (
            <li key={title} aria-current={index === step ? 'step' : undefined}>
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onGo(index)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
                  index === step
                    ? 'border-primary bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground',
                  !reachable && 'opacity-50',
                )}
              >
                <span className="flex size-5 items-center justify-center rounded-full border text-xs">
                  {index < step ? <Check className="size-3" aria-hidden="true" /> : index + 1}
                </span>
                {title}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Wizard({ options, application }: { options: KycOptions; application: KycApplication }) {
  const { notify } = useToast()
  const definition = options.requirementSet.definition
  const draft = application.status === 'DRAFT'
  const [step, setStep] = useState(draft ? 0 : STATUS_STEP)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const save = useSaveAnswers()
  const consent = useRecordConsent()
  const submit = useSubmitApplication()
  const heading = useRef<HTMLHeadingElement>(null)
  const busy = save.isPending || consent.isPending || submit.isPending
  const hasEdits = Object.keys(edits).length > 0

  const move = (index: number) => {
    setStep(index)
    setFailure(null)
    // Moving focus to the new step's heading tells a screen-reader user where they are.
    requestAnimationFrame(() => heading.current?.focus())
  }

  /** Validates what was edited, then saves it. Returns the saved application, or null when something needs fixing first. */
  const flush = async (): Promise<KycApplication | null> => {
    if (!hasEdits) return application
    const problems: Record<string, string> = {}
    for (const [key, value] of Object.entries(edits)) {
      const field = definition.fields.find((f) => f.key === key)
      const problem = field ? fieldProblem(field, value) : null
      if (problem) problems[key] = problem
    }
    setErrors(problems)
    if (Object.keys(problems).length > 0) return null
    try {
      const saved = await save.mutateAsync({
        applicationId: application.id,
        version: application.version,
        answers: edits,
      })
      setEdits({})
      return saved
    } catch (caught) {
      setFailure(messageOf(caught, 'Your draft could not be saved.'))
      return null
    }
  }

  const next = async () => {
    setFailure(null)
    if (step < SECTION_OF_STEP.length) {
      const required = missingRequired(definition, application, edits).filter(
        (key) => definition.fields.find((f) => f.key === key)?.section === SECTION_OF_STEP[step],
      )
      if (required.length > 0) {
        const problems: Record<string, string> = {}
        for (const key of required) {
          problems[key] =
            `${definition.fields.find((f) => f.key === key)?.label ?? 'This'} is required.`
        }
        setErrors(problems)
        setFailure('Please complete the required items marked below.')
        return
      }
    }
    if ((await flush()) !== null) move(Math.min(step + 1, STATUS_STEP))
  }

  const saveDraft = async () => {
    setFailure(null)
    if ((await flush()) !== null) notify('success', 'Draft saved.')
  }

  const giveConsent = async () => {
    setFailure(null)
    const saved = await flush()
    if (!saved) return
    try {
      await consent.mutateAsync({
        applicationId: saved.id,
        version: saved.version,
        textVersion: definition.consent.textVersion,
      })
      notify('success', 'Consent recorded.')
    } catch (caught) {
      setFailure(messageOf(caught, 'Consent could not be recorded.'))
    }
  }

  const submitNow = async () => {
    setFailure(null)
    try {
      await submit.mutateAsync({
        applicationId: application.id,
        version: application.version,
        submissionRequestId: submissionId(application.id),
      })
      forgetSubmission(application.id)
      move(STATUS_STEP)
    } catch (caught) {
      setFailure(
        messageOf(
          caught,
          'The application could not be submitted. Try again: it will not be submitted twice.',
        ),
      )
    }
  }

  const shown = draft ? step : STATUS_STEP
  const title = STEPS[shown]
  return (
    <div className="space-y-4">
      {draft && <Stepper step={step} limit={STATUS_STEP} onGo={move} />}
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
            {title}
          </h2>
          {draft && shown < SECTION_OF_STEP.length && (
            <FieldsStep
              definition={definition}
              application={application}
              section={SECTION_OF_STEP[shown] ?? 'BUSINESS'}
              edits={edits}
              errors={errors}
              revealAvailable={options.storage.revealAvailable}
              onEdit={(key, value) => {
                setEdits((previous) => ({ ...previous, [key]: value }))
                setErrors((previous) => {
                  const rest = { ...previous }
                  delete rest[key]
                  return rest
                })
              }}
            />
          )}
          {shown === 3 && <DocumentsStep application={application} storage={options.storage} />}
          {shown === 4 && (
            <ConsentStep
              definition={definition}
              application={application}
              busy={busy}
              onConsent={() => void giveConsent()}
              onSubmit={() => void submitNow()}
            />
          )}
          {shown === STATUS_STEP && (
            <StatusStep application={application} definition={definition} />
          )}
          {failure && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {failure}
            </p>
          )}
          {draft && step < STATUS_STEP && (
            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={step === 0 || busy}
                  onClick={() => move(step - 1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !hasEdits}
                  onClick={() => void saveDraft()}
                >
                  Save draft
                </Button>
              </div>
              {step < 4 && (
                <Button type="button" disabled={busy} onClick={() => void next()}>
                  Next
                </Button>
              )}
              {hasEdits && (
                <p className="text-xs text-muted-foreground sm:self-center">
                  You have unsaved changes.
                </p>
              )}
            </div>
          )}
          {draft && step === STATUS_STEP && (
            <Button type="button" variant="outline" onClick={() => move(0)}>
              Back to editing
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
