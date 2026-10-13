package rw.oupay.banking;

import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;

/**
 * A merchant's banking configuration (owners only). It stores opaque account identifiers and
 * masked display values, and never asks for, transmits or stores a PIN, password, OTP or
 * online-banking credential. A link made with the simulated provider is a DEMO, not a verified
 * bank connection.
 */
@Service
public class BankingService {

    private final BankConnectionRepository connections;
    private final PaymentDestinationRepository destinations;
    private final ProviderRegistry registry;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public BankingService(BankConnectionRepository connections, PaymentDestinationRepository destinations,
                          ProviderRegistry registry, MerchantAccess access, AuditService audit, Clock clock) {
        this.connections = connections;
        this.destinations = destinations;
        this.registry = registry;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    public List<BankingDtos.ProviderDto> providers() {
        return registry.descriptions().stream()
                .map(d -> new BankingDtos.ProviderDto(d.id(), d.displayName(), d.simulated(), d.available(), registry.capabilities(d.id())))
                .toList();
    }

    @Transactional(readOnly = true)
    public List<BankingDtos.ConnectionDto> listConnections(UUID merchantId) {
        access.require(merchantId, Permission.BANKING_MANAGE);
        return connections.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream().map(BankingDtos.ConnectionDto::of).toList();
    }

    @Transactional(readOnly = true)
    public List<BankingDtos.DestinationDto> listDestinations(UUID merchantId) {
        access.require(merchantId, Permission.BANKING_MANAGE);
        return destinations.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream().map(BankingDtos.DestinationDto::of).toList();
    }

    /** A valid link becomes PENDING until completed; an invalid one becomes ERROR with the reason, so it stays visible. */
    @Transactional
    public BankingDtos.ConnectionDto startLink(UUID merchantId, BankingDtos.LinkRequest request) {
        Actor actor = access.require(merchantId, Permission.BANKING_MANAGE);
        var adapter = registry.adapter(request.providerId())
                .filter(a -> a instanceof BankingProviderAdapter.AccountLinkingCapable)
                .filter(a -> a.capabilities().accountLinking() == Capability.SUPPORTED)
                .orElseThrow(() -> new ApiException(org.springframework.http.HttpStatus.UNPROCESSABLE_CONTENT, "not_supported",
                        "This provider does not support account linking yet."));
        String nickname = request.accountNickname().trim();
        if (nickname.length() < 2) {
            throw ApiException.validation("Give the account a short name (2 to 60 characters).");
        }
        if (connections.existsByMerchantIdAndProviderIdAndStatusIn(merchantId, request.providerId(),
                List.of(BankConnection.Status.PENDING, BankConnection.Status.CONNECTED))) {
            throw ApiException.invalidState("invalid_state", "This provider is already linked. Disable the current connection first.");
        }
        var validation = ((BankingProviderAdapter.AccountLinkingCapable) adapter).validateAccountLink(request.accountReference());
        var now = clock.instant();
        BankConnection connection = new BankConnection(UUID.randomUUID(), merchantId, request.providerId(),
                validation.valid() ? BankConnection.Status.PENDING : BankConnection.Status.ERROR, nickname,
                validation.providerAccountId(), validation.maskedAccount(), adapter.isSimulated(),
                validation.valid() ? null : validation.failureReason(), now);
        try {
            connections.saveAndFlush(connection);
        } catch (DataIntegrityViolationException race) {
            throw ApiException.invalidState("invalid_state", "This provider or account is already linked.");
        }
        // The reference the owner typed is never stored or logged: only the opaque ID and the masked value.
        audit.record(merchantId, actor.userId(), "BANK_LINK_STARTED", "bank_connection", connection.getId(),
                "Started linking " + request.providerId() + (adapter.isSimulated() ? " (simulated)." : "."));
        return BankingDtos.ConnectionDto.of(connection);
    }

    @Transactional
    public BankingDtos.ConnectionDto completeLink(UUID merchantId, UUID connectionId) {
        Actor actor = access.require(merchantId, Permission.BANKING_MANAGE);
        BankConnection connection = find(merchantId, connectionId);
        if (connection.getStatus() != BankConnection.Status.PENDING) {
            throw ApiException.invalidState("invalid_state", "Only a pending connection can be completed.");
        }
        connection.changeStatus(BankConnection.Status.CONNECTED, clock.instant());
        destinations.save(new PaymentDestination(UUID.randomUUID(), merchantId, connection, clock.instant()));
        audit.record(merchantId, actor.userId(), "BANK_LINK_COMPLETED", "bank_connection", connectionId, "Bank link connected.");
        return BankingDtos.ConnectionDto.of(connection);
    }

    /** Stops using a connection: its payment links stop working and its events are refused. */
    @Transactional
    public BankingDtos.ConnectionDto disable(UUID merchantId, UUID connectionId) {
        Actor actor = access.require(merchantId, Permission.BANKING_MANAGE);
        BankConnection connection = find(merchantId, connectionId);
        if (connection.getStatus() == BankConnection.Status.DISABLED) {
            throw ApiException.invalidState("invalid_state", "This connection is already disabled.");
        }
        connection.changeStatus(BankConnection.Status.DISABLED, clock.instant());
        audit.record(merchantId, actor.userId(), "BANK_LINK_DISABLED", "bank_connection", connectionId, "Bank link disabled.");
        return BankingDtos.ConnectionDto.of(connection);
    }

    private BankConnection find(UUID merchantId, UUID connectionId) {
        return connections.findByIdAndMerchantId(connectionId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This connection could not be found."));
    }
}
