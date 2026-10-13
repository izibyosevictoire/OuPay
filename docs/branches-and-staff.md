# Branches, staff and assignments

Frontend-only design notes. Everything below is enforced by **mock services** so the demo
behaves realistically; the real backend must enforce the same rules independently, because
anything running in the browser can be bypassed.

## Relationships

```
Merchant (business)
 ├─ Branch (many)                 belongs to exactly one merchant; immutable id
 ├─ BusinessMembership (many)     links a User to the merchant: role + status
 │    └─ BranchAssignment (many)  links an ACTIVE membership to a branch of the SAME merchant
 └─ StaffInvitation (many)        pending offer; owns an INVITED membership until accepted
User                              no role of its own; may hold memberships in many merchants
```

There is no separate cashier entity: a "cashier" is a User with a `CASHIER` membership.

## Membership lifecycle

```
INVITED ──accept──▶ ACTIVE ◀──reactivate── SUSPENDED
   │                  │ ──suspend──▶          │
   └──────────────────┴────── revoke ─────────┘──▶ REVOKED (terminal)
```

- Inviting never creates an ACTIVE membership. Existing users get an INVITED membership
  linked to their User; a new email gets a `PENDING` user placeholder that cannot sign in.
- REVOKED is never restored. A new invitation creates a new membership; the old one stays as history.
- Revoking ends every branch assignment and cancels any pending invitation.
- A business always keeps at least one ACTIVE owner: the last one cannot be suspended,
  revoked or demoted.
- Nobody may raise their own role, or suspend themselves.

## Who may do what

Derived from the central permission table (`features/auth/permissions`):

| Action | Owner (`membership:manage`) | Manager (`cashiers:manage`) | Cashier |
|---|---|---|---|
| View staff list | yes | yes | no |
| Invite | managers and cashiers | cashiers only | no |
| Change role | yes | no | no |
| Assign branches, suspend, reactivate, revoke | anyone | cashiers only | no |
| Create/edit/(de)activate branches (`branches:manage`) | yes | yes | no |

## Branches

- `ACTIVE` branches can receive assignments (and, in future, invoices).
- `INACTIVE` branches keep all history. Existing assignments stay and can be removed, but no
  *new* assignment can be made to them.
- Branch codes are unique per merchant (case-insensitive, stored upper-case).

## How branch assignment interacts with permissions and records

Not yet enforced for invoices (that module does not exist), but this is the intended contract:

1. **Role decides *what* you may do.** A branch assignment never grants a permission.
2. **Assignment decides *where* you work.** For future write actions (e.g. creating an
   invoice at a branch) an ACTIVE assignment to an ACTIVE branch will be a precondition.
3. **Read scope stays separate.** A cashier's `limited` scope means "records assigned to me"
   (`assignedUserId`). Being assigned to a branch does not reveal that branch's other records.
4. Owners and managers have `all` scope across every branch of their own business.
5. Future records carry `merchantId`, `branchId` and (where relevant) `assignedUserId`;
   deactivating a branch never rewrites them.

## Data isolation

- Every branch and staff service method takes a `merchantId` and verifies the signed-in
  user has an ACTIVE membership there (non-members get "not found") and the needed permission.
- React Query keys always contain the merchant ID; mutations invalidate only that merchant's
  branches, staff and dashboard queries (`features/organization/organizationQueries.ts`).

## Demo invitations

No email is sent. After inviting, the UI shows a demo link (`/accept-invitation/<token>`).
Tokens are visible to the inviter in the mock and are **not secure**; a real backend would
email a single-use, expiring link and never return it to the inviter.

- `demo-invite-existing`: invitation for `invitee@oupay.demo` (sign in, then accept).
- `demo-invite-new`: invitation for `new.hire@example.rw` (create account from the link, then accept).
