package rw.oupay.email;

/** Subject plus the plain-text and HTML bodies of one message. */
public record EmailContent(String subject, String text, String html) {}
