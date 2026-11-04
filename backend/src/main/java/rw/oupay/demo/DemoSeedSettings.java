package rw.oupay.demo;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Run-time settings of the demonstration seeder. Nothing here has a usable default for the dangerous parts: the database name to confirm, the
 * database hosts allowed and the passwords are all supplied by the operator at run time (environment or command line) and are never committed.
 */
@Component
public final class DemoSeedSettings {

    private final String confirmDatabase;
    private final List<String> allowedDbHosts;
    private final String emailDomain;
    private final String ownerPassword;
    private final String managerPassword;
    private final String cashierPassword;
    private final Duration mailboxTimeout;

    public DemoSeedSettings(@Value("${oupay.demo-seed.confirm-database:}") String confirmDatabase,
                            @Value("${oupay.demo-seed.allowed-db-hosts:}") String allowedDbHosts,
                            @Value("${oupay.demo-seed.email-domain:demo.oupay.test}") String emailDomain,
                            @Value("${oupay.demo-seed.owner-password:}") String ownerPassword,
                            @Value("${oupay.demo-seed.manager-password:}") String managerPassword,
                            @Value("${oupay.demo-seed.cashier-password:}") String cashierPassword,
                            @Value("${oupay.demo-seed.mailbox-timeout:PT30S}") Duration mailboxTimeout) {
        this.confirmDatabase = confirmDatabase.trim();
        this.allowedDbHosts = Arrays.stream(allowedDbHosts.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        this.emailDomain = emailDomain.trim().toLowerCase(java.util.Locale.ROOT);
        this.ownerPassword = ownerPassword;
        this.managerPassword = managerPassword;
        this.cashierPassword = cashierPassword;
        this.mailboxTimeout = mailboxTimeout;
    }

    String confirmDatabase() {
        return confirmDatabase;
    }

    List<String> allowedDbHosts() {
        return allowedDbHosts;
    }

    String emailDomain() {
        return emailDomain;
    }

    String ownerPassword() {
        return ownerPassword;
    }

    String managerPassword() {
        return managerPassword;
    }

    String cashierPassword() {
        return cashierPassword;
    }

    Duration mailboxTimeout() {
        return mailboxTimeout;
    }
}
