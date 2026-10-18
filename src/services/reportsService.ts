export interface ReportSummary {
  from: string
  to: string
  issuedInvoiceCount: number
  issuedTotalRwf: number
  activeAllocatedToIssuedInvoicesRwf: number
  outstandingForIssuedInvoicesRwf: number
  confirmedIncomingDuringPeriodRwf: number
  unappliedConfirmedDuringPeriodRwf: number
}

export interface ReportDateRange {
  from: string
  to: string
}

export interface ReportsService {
  getSummary(
    merchantId: string,
    range: ReportDateRange,
  ): Promise<ReportSummary>
}
