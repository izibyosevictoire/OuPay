import { Check } from 'lucide-react'
import { ONBOARDING_STEP_TITLES } from '@/constants/merchant'
import { cn } from '@/lib/utils'

interface OnboardingStepperProps {
  currentStepIndex: number
}

export function OnboardingStepper({ currentStepIndex }: OnboardingStepperProps) {
  const totalSteps = ONBOARDING_STEP_TITLES.length
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground sm:hidden">
        Step {currentStepIndex + 1} of {totalSteps}:{' '}
        <span className="font-medium text-foreground">
          {ONBOARDING_STEP_TITLES[currentStepIndex]}
        </span>
      </p>
      <ol className="flex items-center gap-2" aria-label="Registration progress">
        {ONBOARDING_STEP_TITLES.map((title, index) => {
          const isComplete = index < currentStepIndex
          const isCurrent = index === currentStepIndex
          return (
            <li
              key={title}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex flex-1 items-center gap-2"
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  isComplete && 'border-primary bg-primary text-primary-foreground',
                  isCurrent && 'border-primary bg-accent text-accent-foreground',
                  !isComplete && !isCurrent && 'bg-card text-muted-foreground',
                )}
              >
                {isComplete ? <Check className="size-4" aria-hidden="true" /> : index + 1}
              </span>
              <span
                className={cn(
                  'hidden text-sm sm:inline',
                  isCurrent ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {title}
                {(isComplete || isCurrent) && (
                  <>
                    {' '}
                    <span className="sr-only">{isComplete ? '(completed)' : '(current step)'}</span>
                  </>
                )}
              </span>
              {index < totalSteps - 1 && (
                <span
                  className={cn('h-px flex-1', isComplete ? 'bg-primary' : 'bg-border')}
                  aria-hidden="true"
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
