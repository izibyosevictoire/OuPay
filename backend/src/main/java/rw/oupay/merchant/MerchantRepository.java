package rw.oupay.merchant;

import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MerchantRepository extends JpaRepository<Merchant, UUID> {

    boolean existsByTin(String tin);

    boolean existsByRegistrationNumber(String registrationNumber);

    List<Merchant> findByIdIn(Collection<UUID> ids);
}
