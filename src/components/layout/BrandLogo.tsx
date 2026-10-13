export function BrandLogo() {
  return (
    <div className="flex items-center gap-2">
      <span
        className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <span className="size-3.5 rounded-full border-[3px] border-current" />
      </span>
      <span className="text-base font-semibold tracking-tight">
        OuPay <span className="font-normal text-muted-foreground">Business</span>
      </span>
    </div>
  )
}
