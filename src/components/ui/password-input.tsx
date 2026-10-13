import { Eye, EyeOff } from 'lucide-react'
import * as React from 'react'
import { Input } from './input'

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>

/** Password field with a keyboard-accessible show/hide toggle. */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>((props, ref) => {
  const [isVisible, setIsVisible] = React.useState(false)
  return (
    <div className="relative">
      <Input ref={ref} type={isVisible ? 'text' : 'password'} className="pr-11" {...props} />
      <button
        type="button"
        onClick={() => setIsVisible((visible) => !visible)}
        aria-pressed={isVisible}
        aria-label="Show password"
        className="absolute right-0 top-0 flex size-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
      >
        {isVisible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
})
PasswordInput.displayName = 'PasswordInput'

export { PasswordInput }
