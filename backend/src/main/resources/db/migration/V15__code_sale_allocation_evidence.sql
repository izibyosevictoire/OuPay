-- R6d-B: evidence-based allocation of bank money to LIVE code sales. Additive: it only REPLACES the body of the V13 allocation guard
-- (the trigger stays), so V1-V14 are untouched and nothing is weakened: every rule V13 enforced is still enforced, and new ones are added.
--
-- The bank ledger stays the single source of financial truth. Five different facts are never interchangeable:
--   CONFIRMED  the transaction is bank-verified money            (bank_transactions.status)
--   ATTRIBUTED the reported code resolves to one of our codes    (bank_transactions.attribution_status = 'RESOLVED')
--   MATCHED    the payment's exact OP- reference names one sale  (bank_transactions.payment_request_id = the sale)
--   ALLOCATED  money has been applied to the sale's invoice      (payment_allocations)
--   PAID       the invoice has no remaining balance              (derived from allocations)
--
-- What this guard enforces for an allocation to an invoice that was billed through a collection code (the ledger's own guards for
-- amount, status, tenant and overpayment still run afterwards, unchanged):
--   * a DEMONSTRATION sale never receives money, by any route (unchanged from V13);
--   * only a LIVE sale can receive money;
--   * EVERY origin: the money must have reached the sale's own settlement account; a final attribution CONFLICT is never overridden; a reported
--     code must have resolved to the sale's own code (an unresolved or different code is never ignored); and a reference that names another
--     code sale rules this one out;
--   * AUTOMATIC allocation additionally needs ALL the evidence: code resolved to the sale's code, the agent confirmed from the sale snapshot
--     (so the sale, the code and the account agree), the sale named by the exact reference and matched to this transaction, and the transaction's
--     reference equal to the sale's own unique reference. Amount, time, payer, agent and a code alone are never enough.
--   * MANUAL allocation by an authorised person keeps those safeguards but does not require a reported code (the person supplies the evidence).
-- It locks the transaction row first, the same order as the application and the generic allocation guard, so a concurrent change of the
-- evidence cannot race an allocation.
CREATE OR REPLACE FUNCTION guard_code_sale_allocation() RETURNS trigger AS $$
DECLARE
    invoice_channel varchar;
    invoice_demo boolean;
    sale_row code_sales%ROWTYPE;
    tx_row bank_transactions%ROWTYPE;
BEGIN
    SELECT coalesce(sale_channel, 'INVOICE'), is_demonstration INTO invoice_channel, invoice_demo FROM invoices WHERE id = NEW.invoice_id;
    IF invoice_demo THEN
        RAISE EXCEPTION 'a demonstration code sale can never receive bank money';
    END IF;
    IF invoice_channel <> 'CODE' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO sale_row FROM code_sales WHERE invoice_id = NEW.invoice_id AND merchant_id = NEW.merchant_id;
    IF sale_row.payment_request_id IS NULL OR sale_row.presentation_mode <> 'LIVE' THEN
        RAISE EXCEPTION 'only a live code sale can receive bank money';
    END IF;
    SELECT * INTO tx_row FROM bank_transactions WHERE id = NEW.bank_transaction_id AND merchant_id = NEW.merchant_id FOR UPDATE;
    IF tx_row.id IS NULL THEN
        RAISE EXCEPTION 'the bank transaction and the code sale must belong to the same business';
    END IF;
    IF tx_row.attribution_status IS NOT DISTINCT FROM 'CONFLICT' THEN
        RAISE EXCEPTION 'conflicting bank evidence: a transaction with a final attribution conflict can not be applied to a code sale';
    END IF;
    IF tx_row.settlement_destination_id IS DISTINCT FROM sale_row.settlement_destination_id THEN
        RAISE EXCEPTION 'the money did not reach the settlement account of this code sale';
    END IF;
    IF tx_row.reported_code IS NOT NULL
       AND (tx_row.attribution_status IS DISTINCT FROM 'RESOLVED' OR tx_row.collection_code_id IS DISTINCT FROM sale_row.collection_code_id) THEN
        RAISE EXCEPTION 'the bank-reported code does not resolve to the code of this sale';
    END IF;
    IF tx_row.referenced_code_sale_id IS NOT NULL AND tx_row.referenced_code_sale_id <> sale_row.payment_request_id THEN
        RAISE EXCEPTION 'the payment names a different code sale';
    END IF;
    IF NEW.origin <> 'MANUAL' THEN
        IF tx_row.attribution_status IS DISTINCT FROM 'RESOLVED'
           OR tx_row.agent_attribution IS DISTINCT FROM 'CONFIRMED_FROM_SALE_SNAPSHOT'
           OR tx_row.collection_code_id IS DISTINCT FROM sale_row.collection_code_id
           OR tx_row.referenced_code_sale_id IS DISTINCT FROM sale_row.payment_request_id
           OR tx_row.payment_request_id IS DISTINCT FROM sale_row.payment_request_id
           OR tx_row.payment_reference IS DISTINCT FROM sale_row.sale_reference THEN
            RAISE EXCEPTION 'a code sale is not matched to bank money automatically without the bank''s code, account and exact sale reference';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
