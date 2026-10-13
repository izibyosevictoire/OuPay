package rw.oupay.merchant;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

/** Wire shapes matching the frontend's Merchant, CreateMerchantInput and UpdateMerchantInput. */
public final class MerchantDtos {

    private MerchantDtos() {}

    public record Registration(@Size(max = 40) String registrationNumber, @Pattern(regexp = "^[0-9]{9}$", message = "The TIN must be 9 digits.") String tin) {}

    public record Location(
            @NotBlank @Size(max = 60) String province,
            @NotBlank @Size(max = 60) String district,
            @NotBlank @Size(max = 60) String sector,
            @NotBlank @Size(max = 300) String physicalAddress,
            String country) {}

    public record Contact(
            @NotBlank @Size(max = 120) String fullName,
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank @Pattern(regexp = "^\\+?[0-9]{9,15}$", message = "The phone number is not valid.") String phoneNumber) {}

    public record CreateRequest(
            @NotBlank @Size(min = 2, max = 200) String legalName,
            @Size(max = 200) String tradingName,
            @NotNull @Pattern(regexp = "registered_company|cooperative|non_profit|sole_proprietor|informal_vendor") String businessType,
            @NotNull @Valid Registration registration,
            @NotNull @Valid Location location,
            @NotNull @Valid Contact contact) {}

    public record UpdateRequest(
            @Size(max = 200) String tradingName,
            @NotBlank @Size(max = 300) String physicalAddress,
            @NotNull @Valid Contact contact) {}

    public record BankingConfiguration(String status) {}

    public record MerchantDto(
            UUID id, UUID ownerUserId, String legalName, String tradingName, String businessType, String status,
            Registration registration, Location location, Contact contact, BankingConfiguration bankingConfiguration,
            Instant createdAt, Instant updatedAt) {}
}
