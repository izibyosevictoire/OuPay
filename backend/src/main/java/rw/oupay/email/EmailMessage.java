package rw.oupay.email;

/** A rendered message ready to hand to a provider. */
public record EmailMessage(String to, String from, String subject, String text, String html) {}
