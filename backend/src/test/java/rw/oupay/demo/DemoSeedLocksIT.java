package rw.oupay.demo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;

/** R9: the second and third locks. Even in a designated database, a host that is not allow-listed, or a database name that is not confirmed, stops the run. */
@ActiveProfiles("demo-seed")
@TestPropertySource(properties = {
        "oupay.demo-seed.enabled=true",
        "oupay.demo-seed.run-on-startup=false",
        "oupay.demo-seed.exit-after-run=false",
        "oupay.demo-seed.allowed-db-hosts=db.example.invalid",
        "oupay.demo-seed.confirm-database=some_other_database",
        "oupay.demo-seed.owner-password=Demo-Test-Owner-Passw0rd-1"})
class DemoSeedLocksIT extends IntegrationTest {

    @Autowired
    DemoSeeder seeder;

    @BeforeEach
    void designate() {
        jdbc.update("insert into demo_environment (label) values ('integration test demonstration database')");
    }

    @Test
    void aWrongDatabaseNameConfirmationOrANonAllowListedHostRefusesBeforeAnyWrite() {
        assertThatThrownBy(() -> seeder.seed()).isInstanceOf(IllegalStateException.class).hasMessageContaining("confirm-database");
        assertThat(jdbc.queryForObject("select count(*) from users", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from merchants", Integer.class)).isZero();
    }
}
