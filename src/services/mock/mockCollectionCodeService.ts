import {
  COLLECTION_CODE_MAX_BANK_REF,
  COLLECTION_CODE_MAX_LABEL,
  COLLECTION_CODE_MAX_REASON,
  COLLECTION_POINT_MAX_LABEL,
  FINAL_CODE_STATUSES,
} from '@/constants/collectionCodes'
import { UUID_PATTERN } from '@/constants/inventory'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { getPermissionScope, hasPermission } from '@/features/auth/permissions/permissions'
import {
  CollectionCodeServiceError,
  type CollectionCodeService,
} from '@/services/collectionCodeService'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  AssigneeInput,
  CodeAssignment,
  CollectionCode,
  CollectionCodeMemberOption,
  EligibilityIssue,
  MyCollectionCode,
} from '@/types/collectionCodes'
import type { MockAuthStore } from './mockAuthStore'
import { createLedgerStore, newId } from './ledger/mockLedgerStore'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import {
  SAMPLE_CODE_ASSIGNMENTS,
  SAMPLE_COLLECTION_CODES,
  type StoredCodeAssignment,
  type StoredCollectionCode,
} from './sampleCollectionCodes'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockCollectionCodeServiceOptions {
  authStore: MockAuthStore
  delayInMilliseconds?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Easy to read aloud: no 0/O/1/I/L/U. Mirrors the server's internal reference alphabet. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

const fail = (code: ConstructorParameters<typeof CollectionCodeServiceError>[0], message: string) =>
  new CollectionCodeServiceError(code, message)
const invalid = (message: string) => fail('validation', message)

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** Statuses in which a code may be held by someone: a closed, rejected or suspended code is not handed out. */
const ASSIGNABLE_STATUSES = ['REQUESTED', 'REQUEST_DECLARED', 'ACTIVE'] as const

/**
 * DEMO ONLY: an in-browser stand-in for the server's collection-code registry. It makes the decisions the server makes: tenant
 * scoping, `collection_codes:view` / `:assign` / `:manage`, settlement-account ownership and availability, the status
 * transitions a merchant may drive, one open assignment per code, atomic reassignment, assignee and branch eligibility, immutable
 * snapshot history, and an idempotent request by client request id.
 *
 * It deliberately has NO way to approve or activate a code, to record a bank-issued code, or to mark anything bank-approved: those
 * can only exist in sample data, exactly as on the real server, where they come from the bank or an evidenced operator process.
 * It proves nothing about the real server.
 */
export function createMockCollectionCodeService(
  options: MockCollectionCodeServiceOptions,
): CollectionCodeService {
  const { authStore: store } = options
  const ledger = createLedgerStore(store)
  const run = createOperationRunner(options.delayInMilliseconds ?? 350)

  const codes = () =>
    store.loadRecords<StoredCollectionCode>(
      MOCK_STORAGE_KEYS.collectionCodes,
      SAMPLE_COLLECTION_CODES,
    )
  const saveCodes = (all: StoredCollectionCode[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.collectionCodes, all)
  const assignments = () =>
    store.loadRecords<StoredCodeAssignment>(
      MOCK_STORAGE_KEYS.collectionCodeAssignments,
      SAMPLE_CODE_ASSIGNMENTS,
    )
  const saveAssignments = (all: StoredCodeAssignment[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.collectionCodeAssignments, all)

  const nextSeq = () =>
    Math.max(0, ...codes().map((c) => c.seq), ...assignments().map((a) => a.seq)) + 1

  /** Authorisation: signed in, an ACTIVE member of this business (else not found), then the permission. */
  const authorize = (merchantId: string, permission?: Permission): Actor => {
    let actor: Actor
    try {
      actor = requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        throw fail(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found',
          error.message,
        )
      }
      throw error
    }
    if (permission && !hasPermission(actor.membership.role, permission)) {
      throw fail('forbidden', 'You do not have permission to do that.')
    }
    return actor
  }

  const merchantBranches = (merchantId: string) =>
    store.loadBranches().filter((b) => b.merchantId === merchantId)

  /** Branches a person is actively assigned to AND that are active themselves. */
  const activeBranchIdsOf = (merchantId: string, membershipId: string) => {
    const active = new Set(
      merchantBranches(merchantId)
        .filter((b) => b.status === 'ACTIVE')
        .map((b) => b.id),
    )
    return new Set(
      store
        .loadBranchAssignments()
        .filter(
          (a) =>
            a.merchantId === merchantId &&
            a.membershipId === membershipId &&
            a.status === 'ACTIVE' &&
            active.has(a.branchId),
        )
        .map((a) => a.branchId),
    )
  }

  const findCode = (merchantId: string, codeId: string): StoredCollectionCode => {
    const code = codes().find((c) => c.merchantId === merchantId && c.id === codeId)
    if (!code) throw fail('not_found', 'This code could not be found.')
    return code
  }

  const openAssignmentOf = (codeId: string) =>
    assignments().find((a) => a.codeId === codeId && a.validTo === null)

  const toAssignment = (a: StoredCodeAssignment): CodeAssignment => {
    const membership =
      a.validTo === null && a.assigneeKind === 'MEMBER'
        ? store.loadMemberships().find((m) => m.id === a.membershipId)
        : undefined
    return {
      id: a.id,
      codeId: a.codeId,
      assigneeKind: a.assigneeKind,
      membershipId: a.membershipId,
      assigneeUserId: a.assigneeUserId,
      assigneeName: a.assigneeName,
      assigneeRole: a.assigneeRole,
      collectionPointLabel: a.collectionPointLabel,
      branchId: a.branchId,
      branchName: a.branchName,
      branchCode: a.branchCode,
      validFrom: a.validFrom,
      validTo: a.validTo,
      assignedByName: a.assignedByName,
      endedByName: a.endedByName,
      endReason: a.endReason,
      // Live, and only for an open assignment: the snapshot above is never rewritten.
      assigneeCurrentStatus: membership?.status ?? null,
    }
  }

  /**
   * Whether the code can be used for collection RIGHT NOW, computed fresh from the staff, branch and connection data on every
   * call (never stored): bank-provisioned, not simulated, held by exactly one open assignment, settlement account connected,
   * branch active, and, for a person, an ACTIVE member and user who still works at that branch. A collection point has no
   * person to check. History is never consulted or changed.
   */
  const eligibilityOf = (c: StoredCollectionCode, open: StoredCodeAssignment | undefined) => {
    const approved = c.approval !== null && c.externalCode !== null
    const bankProvisioned = c.status === 'ACTIVE' && !c.simulated && approved
    const issues: EligibilityIssue[] = []
    if (c.simulated) issues.push('SIMULATED')
    if (!(c.status === 'ACTIVE' && approved)) issues.push('NOT_BANK_APPROVED')
    if (!open) issues.push('NOT_ASSIGNED')
    const destination = ledger.paymentDestinations
      .load()
      .find((d) => d.merchantId === c.merchantId && d.id === c.settlementDestinationId)
    const connectionStatus = destination
      ? ledger.bankConnections.load().find((x) => x.id === destination.bankConnectionId)?.status
      : c.sampleConnectionStatus
    if (connectionStatus !== 'CONNECTED') issues.push('SETTLEMENT_ACCOUNT_NOT_CONNECTED')
    const branchId = open?.branchId ?? c.branchId
    if (branchId) {
      const branch = merchantBranches(c.merchantId).find((b) => b.id === branchId)
      if (!branch || branch.status !== 'ACTIVE') issues.push('BRANCH_INACTIVE')
    }
    if (open && open.assigneeKind === 'MEMBER') {
      const membership = store.loadMemberships().find((m) => m.id === open.membershipId)
      const user = store.loadUsers().find((u) => u.id === open.assigneeUserId)
      if (!membership || membership.status !== 'ACTIVE' || !user || user.status !== 'ACTIVE') {
        issues.push('ASSIGNEE_NOT_ACTIVE')
      }
      if (
        branchId &&
        !store
          .loadBranchAssignments()
          .some(
            (a) =>
              a.merchantId === c.merchantId &&
              a.membershipId === open.membershipId &&
              a.branchId === branchId &&
              a.status === 'ACTIVE',
          )
      ) {
        issues.push('ASSIGNEE_NOT_AT_BRANCH')
      }
    }
    return { bankProvisioned, issues }
  }

  /** `canSeeEvidence` is true only for people who manage codes: everyone else gets no evidence and no bank reference. */
  const toCode = (c: StoredCollectionCode, canSeeEvidence = false): CollectionCode => {
    const branch = c.branchId
      ? merchantBranches(c.merchantId).find((b) => b.id === c.branchId)
      : undefined
    const open = openAssignmentOf(c.id)
    const approved = c.approval !== null && c.externalCode !== null
    const { bankProvisioned, issues } = eligibilityOf(c, open)
    return {
      id: c.id,
      internalRef: c.internalRef,
      displayLabel: c.displayLabel,
      providerId: c.providerId,
      settlementDestinationId: c.settlementDestinationId,
      settlementAccountLabel: c.settlementAccountLabel,
      settlementAccountMasked: c.settlementAccountMasked,
      simulated: c.simulated,
      branchId: c.branchId,
      branchName: branch?.name ?? null,
      branchCode: branch?.code ?? null,
      status: c.status,
      statusReason: c.statusReason,
      bankRequestRef: canSeeEvidence ? c.bankRequestRef : null,
      externalCodeState: approved ? 'BANK_APPROVED' : 'NOT_ISSUED',
      externalCode: approved ? c.externalCode : null,
      approval: c.approval
        ? {
            source: c.approval.source,
            approvedAt: c.approval.approvedAt,
            evidenceRef: canSeeEvidence ? c.approval.evidenceRef : null,
          }
        : null,
      bankProvisioned,
      payable: issues.length === 0,
      eligibilityIssues: issues,
      currentAssignment: open ? toAssignment(open) : null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      version: c.version,
    }
  }

  /** Plain wording for an agent. Nothing here suggests Equity has received or accepted anything. */
  const myCodeMessage = (code: CollectionCode) => {
    if (code.payable) return 'This code is provisioned by the bank and eligible for collection now.'
    const first = code.eligibilityIssues[0]
    switch (first) {
      case 'SIMULATED':
        return 'This is a simulated code, not a live one. Do not give it to customers.'
      case 'NOT_BANK_APPROVED':
        return code.status === 'REQUEST_DECLARED'
          ? 'Your owner declared a request to the bank. OuPay has no confirmation from Equity. Do not give it to customers.'
          : code.status === 'REQUESTED'
            ? 'This code has been requested inside OuPay only. Do not give it to customers.'
            : `This code is ${code.status.toLowerCase()}, so it is not provisioned by the bank. Do not give it to customers.`
      case 'SETTLEMENT_ACCOUNT_NOT_CONNECTED':
        return 'Its settlement account is not connected right now. Do not give it to customers.'
      case 'BRANCH_INACTIVE':
        return 'Its branch is not active right now. Do not give it to customers.'
      case 'ASSIGNEE_NOT_AT_BRANCH':
        return 'You are no longer assigned to this code’s branch. Do not give it to customers.'
      default:
        return 'This code is not eligible for collection right now. Do not give it to customers.'
    }
  }

  const pageOf = <T>(
    rows: T[],
    limitInput: number | undefined,
    cursor: string | null | undefined,
  ) => {
    const limit = Math.min(limitInput && limitInput > 0 ? limitInput : DEFAULT_LIMIT, MAX_LIMIT)
    const offset = cursor ? Number(cursor) : 0
    if (!Number.isInteger(offset) || offset < 0) throw invalid('The page cursor is not valid.')
    return {
      items: rows.slice(offset, offset + limit),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    }
  }

  const cleanText = (
    value: unknown,
    max: number,
    what: string,
    required: boolean,
  ): string | null => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed) {
      if (required) throw invalid(`Enter a ${what}.`)
      return null
    }
    if (trimmed.length > max || CONTROL_CHARACTERS.test(trimmed)) {
      throw invalid(`The ${what} can be at most ${max} characters, on one line.`)
    }
    return trimmed
  }

  const requireVersion = (code: StoredCollectionCode, expected: unknown) => {
    if (typeof expected !== 'number' || code.version !== expected) {
      throw fail(
        'version_conflict',
        'This code was changed by someone else. Reload it and try again.',
      )
    }
  }

  /** A manager (scope `limited`) acts only on codes of branches they are assigned to; codes with no branch are the owner's. */
  const requireAssignScope = (actor: Actor, code: StoredCollectionCode) => {
    if (getPermissionScope(actor.membership.role, 'collection_codes:assign') === 'all') return
    if (
      !code.branchId ||
      !activeBranchIdsOf(code.merchantId, actor.membership.id).has(code.branchId)
    ) {
      throw fail('forbidden', 'You can only manage codes of branches you are assigned to.')
    }
  }

  const newInternalRef = () => {
    const taken = new Set(codes().map((c) => c.internalRef))
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(8))
      const ref = `CC-${Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('')}`
      if (!taken.has(ref)) return ref
    }
  }

  // ---- assignee rules -----------------------------------------------------------------------------------------------

  interface ResolvedAssignee {
    kind: 'MEMBER' | 'COLLECTION_POINT'
    membershipId: string | null
    userId: string | null
    name: string
    role: string | null
    label: string | null
    branchId: string | null
    branchName: string | null
    branchCode: string | null
  }

  /** Who may hold the code, and where. Throws the reason someone is not eligible. */
  const resolveAssignee = (
    code: StoredCollectionCode,
    input: AssigneeInput,
    actor: Actor,
  ): ResolvedAssignee => {
    const hasMember = typeof input.membershipId === 'string' && input.membershipId !== ''
    const hasPoint =
      typeof input.collectionPointLabel === 'string' && input.collectionPointLabel.trim() !== ''
    if (hasMember === hasPoint) {
      throw invalid('Choose either a team member or a collection point.')
    }
    let branchId = code.branchId
    if (input.branchId) {
      if (code.branchId && code.branchId !== input.branchId) {
        throw fail('branch_not_eligible', 'This code belongs to a different branch.')
      }
      branchId = input.branchId
    }
    const branch = branchId
      ? merchantBranches(code.merchantId).find((b) => b.id === branchId)
      : undefined
    if (branchId && (!branch || branch.status !== 'ACTIVE')) {
      throw fail('branch_not_eligible', 'Choose an active branch of this business.')
    }
    // A manager may only place codes at branches they work at themselves.
    if (
      branchId &&
      getPermissionScope(actor.membership.role, 'collection_codes:assign') !== 'all' &&
      !activeBranchIdsOf(code.merchantId, actor.membership.id).has(branchId)
    ) {
      throw fail('forbidden', 'You can only manage codes of branches you are assigned to.')
    }
    if (hasPoint) {
      const label = cleanText(
        input.collectionPointLabel,
        COLLECTION_POINT_MAX_LABEL,
        'collection point name',
        true,
      )!
      return {
        kind: 'COLLECTION_POINT',
        membershipId: null,
        userId: null,
        name: label,
        role: null,
        label,
        branchId,
        branchName: branch?.name ?? null,
        branchCode: branch?.code ?? null,
      }
    }
    const membership = store
      .loadMemberships()
      .find((m) => m.id === input.membershipId && m.merchantId === code.merchantId)
    if (!membership || membership.status !== 'ACTIVE') {
      throw fail('assignee_not_eligible', 'Only an active member of this business can hold a code.')
    }
    if (branchId && !activeBranchIdsOf(code.merchantId, membership.id).has(branchId)) {
      throw fail('assignee_not_eligible', 'That person is not assigned to this code’s branch.')
    }
    const user = store.loadUsers().find((u) => u.id === membership.userId)
    return {
      kind: 'MEMBER',
      membershipId: membership.id,
      userId: membership.userId,
      name: user?.fullName ?? 'Team member',
      role: membership.role,
      label: null,
      branchId,
      branchName: branch?.name ?? null,
      branchCode: branch?.code ?? null,
    }
  }

  const requireAssignable = (code: StoredCollectionCode) => {
    if (!(ASSIGNABLE_STATUSES as readonly string[]).includes(code.status)) {
      throw fail('code_status_invalid', 'A code in this status cannot be given to anyone.')
    }
  }

  const openAssignment = (
    code: StoredCollectionCode,
    who: ResolvedAssignee,
    actor: Actor,
    at: string,
  ): StoredCodeAssignment => ({
    id: newId('cca'),
    merchantId: code.merchantId,
    codeId: code.id,
    assigneeKind: who.kind,
    membershipId: who.membershipId,
    assigneeUserId: who.userId,
    assigneeName: who.name,
    assigneeRole: who.role,
    collectionPointLabel: who.label,
    branchId: who.branchId,
    branchName: who.branchName,
    branchCode: who.branchCode,
    validFrom: at,
    validTo: null,
    assignedByName: actor.user.fullName,
    endedByName: null,
    endReason: null,
    seq: nextSeq(),
  })

  const endOf = (
    row: StoredCodeAssignment,
    actor: Actor,
    reason: string,
    at: string,
  ): StoredCodeAssignment => ({
    ...row,
    validTo: at,
    endedByName: actor.user.fullName,
    endReason: reason,
  })

  // ---- the service ---------------------------------------------------------------------------------------------------

  return {
    getOptions: (merchantId) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:view')
        const canRequest = hasPermission(actor.membership.role, 'collection_codes:manage')
        const connections = ledger.bankConnections.load().filter((c) => c.merchantId === merchantId)
        const destinations = canRequest
          ? ledger.paymentDestinations
              .load()
              .filter((d) => d.merchantId === merchantId)
              .map((d) => ({
                id: d.id,
                label: d.label,
                maskedAccount: d.maskedAccount,
                providerId: d.providerId,
                simulated: d.isSimulated,
                connectionStatus:
                  connections.find((c) => c.id === d.bankConnectionId)?.status ?? 'DISABLED',
              }))
          : []
        const branches = merchantBranches(merchantId).map((b) => ({
          id: b.id,
          name: b.name,
          code: b.code,
          status: b.status,
        }))
        const users = store.loadUsers()
        const members: CollectionCodeMemberOption[] = store
          .loadMemberships()
          .filter((m) => m.merchantId === merchantId && m.status === 'ACTIVE')
          .map((m) => ({
            membershipId: m.id,
            userId: m.userId,
            fullName: users.find((u) => u.id === m.userId)?.fullName ?? 'Team member',
            role: m.role,
            branchIds: [...activeBranchIdsOf(merchantId, m.id)],
          }))
        return { destinations, branches, members }
      }),

    listCodes: (merchantId, query) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:view')
        const evidence = hasPermission(actor.membership.role, 'collection_codes:manage')
        const term = query?.q?.trim().toLowerCase() ?? ''
        const rows = codes()
          .filter((c) => c.merchantId === merchantId)
          .filter((c) => !query?.status || c.status === query.status)
          .filter((c) => !query?.branchId || c.branchId === query.branchId)
          .filter(
            (c) =>
              !term ||
              c.displayLabel.toLowerCase().includes(term) ||
              c.internalRef.toLowerCase().includes(term) ||
              (c.externalCode?.toLowerCase().includes(term) ?? false),
          )
          .sort((a, b) => b.seq - a.seq)
        const page = pageOf(rows, query?.limit, query?.cursor)
        return { items: page.items.map((c) => toCode(c, evidence)), nextCursor: page.nextCursor }
      }),

    getCode: (merchantId, codeId) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:view')
        return toCode(
          findCode(merchantId, codeId),
          hasPermission(actor.membership.role, 'collection_codes:manage'),
        )
      }),

    requestCode: (merchantId, input) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:manage')
        if (
          typeof input.clientOperationId !== 'string' ||
          !UUID_PATTERN.test(input.clientOperationId)
        ) {
          throw invalid('The request identifier is not valid.')
        }
        const label = cleanText(input.displayLabel, COLLECTION_CODE_MAX_LABEL, 'label', true)!
        const fingerprint = JSON.stringify([
          actor.user.id,
          input.settlementDestinationId,
          label,
          input.branchId ?? '',
        ])
        const existing = codes().find(
          (c) => c.merchantId === merchantId && c.clientOperationId === input.clientOperationId,
        )
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw fail(
              'client_request_id_reuse',
              'This request identifier was already used for a different request.',
            )
          }
          return { code: toCode(existing, true), replayed: true }
        }
        const destination = ledger.paymentDestinations
          .load()
          .find((d) => d.merchantId === merchantId && d.id === input.settlementDestinationId)
        if (!destination) throw fail('not_found', 'This settlement account could not be found.')
        const connection = ledger.bankConnections
          .load()
          .find((c) => c.id === destination.bankConnectionId && c.merchantId === merchantId)
        if (!connection || connection.status !== 'CONNECTED') {
          throw fail(
            'settlement_account_unavailable',
            'This settlement account is not connected, so no code can be requested for it.',
          )
        }
        if (input.branchId) {
          const branch = merchantBranches(merchantId).find((b) => b.id === input.branchId)
          if (!branch || branch.status !== 'ACTIVE') {
            throw fail('branch_not_eligible', 'Choose an active branch of this business.')
          }
        }
        const now = new Date().toISOString()
        const record: StoredCollectionCode = {
          id: newId('cc'),
          merchantId,
          internalRef: newInternalRef(),
          displayLabel: label,
          providerId: destination.providerId,
          settlementDestinationId: destination.id,
          settlementAccountLabel: destination.label,
          settlementAccountMasked: destination.maskedAccount,
          simulated: destination.isSimulated,
          branchId: input.branchId ?? null,
          // An internal request only. Nothing is sent to Equity and nothing is approved.
          status: 'REQUESTED',
          statusReason: null,
          bankRequestRef: null,
          externalCode: null,
          approval: null,
          clientOperationId: input.clientOperationId,
          fingerprint,
          createdByUserId: actor.user.id,
          createdAt: now,
          updatedAt: now,
          seq: nextSeq(),
          version: 0,
        }
        saveCodes([...codes(), record])
        return { code: toCode(record, true), replayed: false }
      }),

    listAssignments: (merchantId, codeId, query) =>
      run(() => {
        authorize(merchantId, 'collection_codes:view')
        findCode(merchantId, codeId)
        const rows = assignments()
          .filter((a) => a.codeId === codeId && a.merchantId === merchantId)
          .sort((a, b) => b.seq - a.seq)
        const page = pageOf(rows, query?.limit, query?.cursor)
        return { items: page.items.map(toAssignment), nextCursor: page.nextCursor }
      }),

    assign: (merchantId, codeId, input) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:assign')
        const code = findCode(merchantId, codeId)
        requireAssignScope(actor, code)
        requireAssignable(code)
        if (openAssignmentOf(code.id)) {
          throw fail('already_assigned', 'This code already has an agent. Reassign it instead.')
        }
        const who = resolveAssignee(code, input, actor)
        const row = openAssignment(code, who, actor, new Date().toISOString())
        saveAssignments([...assignments(), row])
        return toAssignment(row)
      }),

    endAssignment: (merchantId, codeId, input) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:assign')
        const code = findCode(merchantId, codeId)
        requireAssignScope(actor, code)
        const reason = cleanText(input.reason, COLLECTION_CODE_MAX_REASON, 'reason', true)!
        const open = openAssignmentOf(code.id)
        if (!open) throw fail('no_open_assignment', 'This code has no agent to remove.')
        if (open.id !== input.expectedAssignmentId) {
          throw fail('assignment_changed', 'The assignment changed. Reload and try again.')
        }
        const ended = endOf(open, actor, reason, new Date().toISOString())
        saveAssignments(assignments().map((a) => (a.id === open.id ? ended : a)))
        return toAssignment(ended)
      }),

    reassign: (merchantId, codeId, input) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:assign')
        const code = findCode(merchantId, codeId)
        requireAssignScope(actor, code)
        requireAssignable(code)
        const reason = cleanText(input.reason, COLLECTION_CODE_MAX_REASON, 'reason', true)!
        const open = openAssignmentOf(code.id)
        if (!open)
          throw fail('no_open_assignment', 'This code has no agent to replace. Assign it instead.')
        if (open.id !== input.expectedAssignmentId) {
          throw fail('assignment_changed', 'The assignment changed. Reload and try again.')
        }
        // Everything is checked BEFORE anything is written, so a refusal never leaves the code without its agent.
        const who = resolveAssignee(code, input, actor)
        if (who.kind === 'MEMBER' && who.membershipId === open.membershipId) {
          throw fail('already_assigned', 'This person already holds the code.')
        }
        const now = new Date().toISOString()
        const ended = endOf(open, actor, reason, now)
        const next = openAssignment(code, who, actor, now)
        saveAssignments([...assignments().map((a) => (a.id === open.id ? ended : a)), next])
        return toAssignment(next)
      }),

    declareSubmission: (merchantId, codeId, input) =>
      run(() => {
        authorize(merchantId, 'collection_codes:manage')
        const code = findCode(merchantId, codeId)
        requireVersion(code, input.expectedVersion)
        const reference = cleanText(
          input.bankRequestRef,
          COLLECTION_CODE_MAX_BANK_REF,
          'bank reference',
          true,
        )!
        if (code.status !== 'REQUESTED') {
          throw fail(
            'code_status_invalid',
            'A bank request can only be recorded for a new request.',
          )
        }
        // The owner's own record of a request. This is NOT approval and nothing is verified with Equity.
        const updated: StoredCollectionCode = {
          ...code,
          status: 'REQUEST_DECLARED',
          bankRequestRef: reference,
          updatedAt: new Date().toISOString(),
          version: code.version + 1,
        }
        saveCodes(codes().map((c) => (c.id === code.id ? updated : c)))
        return toCode(updated, true)
      }),

    suspend: (merchantId, codeId, input) =>
      run(() => {
        authorize(merchantId, 'collection_codes:manage')
        const code = findCode(merchantId, codeId)
        requireVersion(code, input.expectedVersion)
        const reason = cleanText(input.reason, COLLECTION_CODE_MAX_REASON, 'reason', true)!
        if (code.status !== 'ACTIVE') {
          throw fail('code_status_invalid', 'Only an active code can be suspended.')
        }
        const updated: StoredCollectionCode = {
          ...code,
          status: 'SUSPENDED',
          statusReason: reason,
          updatedAt: new Date().toISOString(),
          version: code.version + 1,
        }
        saveCodes(codes().map((c) => (c.id === code.id ? updated : c)))
        return toCode(updated, true)
      }),

    deactivate: (merchantId, codeId, input) =>
      run(() => {
        const actor = authorize(merchantId, 'collection_codes:manage')
        const code = findCode(merchantId, codeId)
        requireVersion(code, input.expectedVersion)
        const reason = cleanText(input.reason, COLLECTION_CODE_MAX_REASON, 'reason', true)!
        if (FINAL_CODE_STATUSES.includes(code.status)) {
          throw fail('code_status_invalid', 'This code is already closed.')
        }
        const now = new Date().toISOString()
        const updated: StoredCollectionCode = {
          ...code,
          status: 'DEACTIVATED',
          statusReason: reason,
          updatedAt: now,
          version: code.version + 1,
        }
        // Deactivating ends any open assignment in the same step; history is kept, never deleted.
        const open = openAssignmentOf(code.id)
        if (open) {
          const ended = endOf(open, actor, `Code deactivated: ${reason}`, now)
          saveAssignments(assignments().map((a) => (a.id === open.id ? ended : a)))
        }
        saveCodes(codes().map((c) => (c.id === code.id ? updated : c)))
        return toCode(updated, true)
      }),

    getMyCode: (merchantId) =>
      run((): MyCollectionCode => {
        const actor = authorize(merchantId)
        const mine = assignments().find(
          (a) =>
            a.merchantId === merchantId &&
            a.validTo === null &&
            a.assigneeKind === 'MEMBER' &&
            a.membershipId === actor.membership.id,
        )
        if (!mine) return { assignment: null, code: null }
        const stored = findCode(merchantId, mine.codeId)
        const code = toCode(stored)
        const message = myCodeMessage(code)
        return {
          assignment: toAssignment(mine),
          code: {
            id: code.id,
            displayLabel: code.displayLabel,
            status: code.status,
            simulated: code.simulated,
            branchName: code.branchName,
            payable: code.payable,
            // The code value is shown to an agent ONLY when the code is eligible for collection right now.
            externalCode: code.payable ? code.externalCode : null,
            message,
          },
        }
      }),
  }
}
