package rw.oupay.merchant;

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MerchantSettingsRepository extends JpaRepository<MerchantSettings, UUID> {
}
