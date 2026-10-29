import { Navigate, type RouteObject } from 'react-router-dom'
import { AppShell } from '@/app/layouts/AppShell'
import { AuthLayout } from '@/app/layouts/AuthLayout'
import { OnboardingLayout } from '@/app/layouts/OnboardingLayout'
import { PrintLayout } from '@/app/layouts/PrintLayout'
import { PublicPaymentLayout } from '@/app/layouts/PublicPaymentLayout'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage'
import { LoginPage } from '@/features/auth/pages/LoginPage'
import { RegisterPage } from '@/features/auth/pages/RegisterPage'
import { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage'
import { VerifyEmailPage } from '@/features/auth/pages/VerifyEmailPage'
import { BankingPage } from '@/features/banking/BankingPage'
import { BranchDetailsPage } from '@/features/branches/BranchDetailsPage'
import { BranchesPage } from '@/features/branches/BranchesPage'
import { CatalogPage } from '@/features/catalog/CatalogPage'
import { PosPage } from '@/features/pos/PosPage'
import { CollectionCodesPage } from '@/features/collectionCodes/CollectionCodesPage'
import { InventoryPage } from '@/features/inventory/InventoryPage'
import { EquityActivationPage } from '@/features/equityActivation/EquityActivationPage'
import { SimplifiedCheckoutPage } from '@/features/checkout/SimplifiedCheckoutPage'
import { CodeCheckoutPage } from '@/features/codeCheckout/CodeCheckoutPage'
import { PublicCodeSalePage } from '@/features/codeCheckout/PublicCodeSalePage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { BankSimulatorPage } from '@/features/demo/BankSimulatorPage'
import { EditInvoicePage } from '@/features/invoices/EditInvoicePage'
import { InvoiceDetailsPage } from '@/features/invoices/InvoiceDetailsPage'
import { InvoicePrintPage } from '@/features/invoices/InvoicePrintPage'
import { InvoicesPage } from '@/features/invoices/InvoicesPage'
import { NewInvoicePage } from '@/features/invoices/NewInvoicePage'
import { OnboardingPage } from '@/features/merchants/onboarding/OnboardingPage'
import { MerchantProfilePage } from '@/features/merchants/profile/MerchantProfilePage'
import { MerchantSettingsPage } from '@/features/merchants/settings/MerchantSettingsPage'
import { PaymentLinkDetailsPage } from '@/features/paymentLinks/PaymentLinkDetailsPage'
import { PaymentLinkPrintPage } from '@/features/paymentLinks/PaymentLinkPrintPage'
import { PaymentLinksPage } from '@/features/paymentLinks/PaymentLinksPage'
import { PaymentsPage } from '@/features/payments/PaymentsPage'
import { TransactionDetailsPage } from '@/features/payments/TransactionDetailsPage'
import { TransactionsPage } from '@/features/payments/TransactionsPage'
import { PublicProfilePage } from '@/features/publicPayment/PublicProfilePage'
import { PublicRequestPage } from '@/features/publicPayment/PublicRequestPage'
import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import { ModulePlaceholderPage } from '@/features/placeholders/ModulePlaceholderPage'
import { AcceptInvitationPage } from '@/features/staff/AcceptInvitationPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { NotFoundPage } from '@/features/placeholders/NotFoundPage'
import { BusinessRoute, PermissionRoute, ProtectedRoute, PublicOnlyRoute } from './guards'

/** Placeholder modules, each behind the permission its navigation entry declares. */
const BUILT_MODULE_PATHS = [
  '/',
  '/branches',
  '/cashiers',
  '/invoices',
  '/catalog',
  '/inventory',
  '/collection-codes',
  '/collect',
  '/code-checkout',
  '/pos',
  '/equity-activation',
  '/transactions',
  '/payments',
  '/payment-links',
  '/banking',
  '/reports',
  '/settings',
]
const moduleRoutes: RouteObject[] = PRIMARY_NAVIGATION.filter(
  ({ path }) => !BUILT_MODULE_PATHS.includes(path),
).map(({ path, label, description, permission }) => {
  const page = <ModulePlaceholderPage title={label} description={description} />
  return permission
    ? {
        element: <PermissionRoute permission={permission} />,
        children: [{ path, element: page }],
      }
    : { path, element: page }
})

export const appRoutes: RouteObject[] = [
  {
    // Signed-in users are sent away from these.
    element: <PublicOnlyRoute />,
    children: [
      {
        element: <AuthLayout />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <RegisterPage /> },
        ],
      },
    ],
  },
  {
    // Reachable whether or not someone is signed in (reset links open in any browser state).
    element: <AuthLayout />,
    children: [
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <Navigate to="/forgot-password" replace /> },
      { path: '/reset-password/:token', element: <ResetPasswordPage /> },
      // The link in the "confirm your email address" message; works in any sign-in state.
      { path: '/verify-email/:token', element: <VerifyEmailPage /> },
      // Open to anyone holding the link; the page decides what to show for their sign-in state.
      { path: '/accept-invitation/:token', element: <AcceptInvitationPage /> },
    ],
  },
  {
    // Anonymous customer pages: no sign-in, outside every guard, and they only ever receive
    // what the public payment service returns for the public token.
    element: <PublicPaymentLayout />,
    children: [
      { path: '/p/:paymentProfileId', element: <PublicProfilePage /> },
      { path: '/p/:paymentProfileId/r/:publicReference', element: <PublicRequestPage /> },
      { path: '/code-sale/:reference', element: <PublicCodeSalePage /> },
    ],
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        // Needs a user but no business yet: this is where a first business is created.
        element: <OnboardingLayout />,
        children: [{ path: '/onboarding', element: <OnboardingPage /> }],
      },
      {
        element: <BusinessRoute />,
        children: [
          {
            // Printable documents: same access rules, but no app chrome.
            element: <PermissionRoute permission="invoices:view" />,
            children: [
              {
                element: <PrintLayout />,
                children: [{ path: '/invoices/:invoiceId/print', element: <InvoicePrintPage /> }],
              },
            ],
          },
          {
            element: <PermissionRoute permission="payment_profiles:view" />,
            children: [
              {
                element: <PrintLayout />,
                children: [
                  { path: '/payment-links/:profileId/print', element: <PaymentLinkPrintPage /> },
                ],
              },
            ],
          },
          {
            element: <AppShell />,
            children: [
              {
                element: <PermissionRoute permission="dashboard:view" />,
                children: [{ index: true, element: <DashboardPage /> }],
              },
              {
                element: <PermissionRoute permission="profile:view" />,
                children: [
                  { path: '/profile', element: <MerchantProfilePage /> },
                  { path: '/settings', element: <MerchantSettingsPage /> },
                ],
              },
              {
                element: <PermissionRoute permission="invoices:view" />,
                children: [
                  { path: '/invoices', element: <InvoicesPage /> },
                  { path: '/invoices/:invoiceId', element: <InvoiceDetailsPage /> },
                  { path: '/invoices/:invoiceId/edit', element: <EditInvoicePage /> },
                ],
              },
              {
                element: <PermissionRoute permission="invoices:create" />,
                children: [
                  { path: '/invoices/new', element: <NewInvoicePage /> },
                  // The page itself explains when the business is not in simplified mode (and what to do instead).
                  { path: '/collect', element: <SimplifiedCheckoutPage /> },
                  // The page itself explains when the person holds no code, or the code cannot bill.
                  { path: '/code-checkout', element: <CodeCheckoutPage /> },
                  // The page itself explains when the business is not in business mode, or the person has no branch.
                  { path: '/pos', element: <PosPage /> },
                ],
              },
              {
                // The page itself explains when the business is not in business mode.
                element: <PermissionRoute permission="catalog:view" />,
                children: [{ path: '/catalog', element: <CatalogPage /> }],
              },
              {
                // The page itself explains when the business is not in business mode.
                element: <PermissionRoute permission="inventory:view" />,
                children: [{ path: '/inventory', element: <InventoryPage /> }],
              },
              // Open to every member: the page shows the registry to those who may manage it and the person’s own code to everyone else.
              { path: '/collection-codes', element: <CollectionCodesPage /> },
              {
                element: <PermissionRoute permission="branches:manage" />,
                children: [
                  { path: '/branches', element: <BranchesPage /> },
                  { path: '/branches/:branchId', element: <BranchDetailsPage /> },
                ],
              },
              {
                element: <PermissionRoute permission="cashiers:manage" />,
                children: [{ path: '/cashiers', element: <StaffPage /> }],
              },
              {
                element: <PermissionRoute permission="transactions:view" />,
                children: [
                  { path: '/transactions', element: <TransactionsPage /> },
                  { path: '/transactions/:transactionId', element: <TransactionDetailsPage /> },
                ],
              },
              {
                element: <PermissionRoute permission="payments:view_confirmations" />,
                children: [{ path: '/payments', element: <PaymentsPage /> }],
              },
              {
                element: <PermissionRoute permission="payment_profiles:view" />,
                children: [
                  { path: '/payment-links', element: <PaymentLinksPage /> },
                  { path: '/payment-links/:profileId', element: <PaymentLinkDetailsPage /> },
                ],
              },
              {
                element: <PermissionRoute permission="banking:manage" />,
                children: [{ path: '/banking', element: <BankingPage /> }],
              },
              {
                // Owner only: the page holds a representative's identity details.
                element: <PermissionRoute permission="kyc:manage" />,
                children: [{ path: '/equity-activation', element: <EquityActivationPage /> }],
              },
              {
                element: <PermissionRoute permission="reports:view" />,
                children: [{ path: '/reports', element: <ReportsPage /> }],
              },
              // Demo tooling exists only when demo tools are enabled.
              ...(DEMO_TOOLS_BUILD
                ? [
                    {
                      element: <PermissionRoute permission="payments:reconcile" />,
                      children: [{ path: '/demo/bank-simulator', element: <BankSimulatorPage /> }],
                    },
                  ]
                : []),
              ...moduleRoutes,
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]
