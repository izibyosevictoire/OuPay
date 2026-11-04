package rw.oupay.sample;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Run-time settings of the sample-data importer. Nothing here has a usable default: the merchant to operate on, the owner who authorises it, the
 * owner's password, the staff addresses and the confirmation of a previewed plan are all supplied by the operator at run time (environment or command
 * line) and are never committed. The password is never printed.
 */
@Component
public final class SampleImportSettings {

    private final String merchantId;
    private final String ownerEmail;
    private final String ownerPassword;
    private final String confirmPlan;
    private final String managerEmail;
    private final List<String> cashierEmails;

    public SampleImportSettings(@Value("${oupay.sample-import.merchant-id:}") String merchantId,
                                @Value("${oupay.sample-import.owner-email:}") String ownerEmail,
                                @Value("${oupay.sample-import.owner-password:}") String ownerPassword,
                                @Value("${oupay.sample-import.confirm-plan:}") String confirmPlan,
                                @Value("${oupay.sample-import.manager-email:}") String managerEmail,
                                @Value("${oupay.sample-import.cashier-emails:}") String cashierEmails) {
        this.merchantId = merchantId.trim();
        this.ownerEmail = ownerEmail.trim().toLowerCase(Locale.ROOT);
        this.ownerPassword = ownerPassword;
        this.confirmPlan = confirmPlan.trim().toLowerCase(Locale.ROOT);
        this.managerEmail = managerEmail.trim().toLowerCase(Locale.ROOT);
        this.cashierEmails = Arrays.stream(cashierEmails.split(",")).map(s -> s.trim().toLowerCase(Locale.ROOT)).filter(s -> !s.isEmpty()).toList();
    }

    /** The one merchant to operate on. Required: there is no "all merchants" and no default. */
    UUID merchantId() {
        if (merchantId.isEmpty()) {
            throw new SampleImportRefusedException("oupay.sample-import.merchant-id is required: name the ONE merchant to add sample data to");
        }
        try {
            return UUID.fromString(merchantId);
        } catch (IllegalArgumentException e) {
            throw new SampleImportRefusedException("oupay.sample-import.merchant-id is not a valid identifier");
        }
    }

    String ownerEmail() {
        if (ownerEmail.isEmpty()) {
            throw new SampleImportRefusedException("oupay.sample-import.owner-email is required: the owner of that merchant authorises the import");
        }
        return ownerEmail;
    }

    String ownerPassword() {
        if (ownerPassword == null || ownerPassword.isBlank()) {
            throw new SampleImportRefusedException("the owner's password must be supplied at run time (OUPAY_SAMPLE_IMPORT_OWNER_PASSWORD); "
                    + "it is used to sign in as the owner and is never stored, printed or reset");
        }
        return ownerPassword;
    }

    /** Empty means a dry run: nothing is written. */
    String confirmPlan() {
        return confirmPlan;
    }

    String managerEmail() {
        return managerEmail;
    }

    List<String> cashierEmails() {
        return cashierEmails;
    }
}
