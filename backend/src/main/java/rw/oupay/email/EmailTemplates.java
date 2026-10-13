package rw.oupay.email;

import java.time.Duration;
import org.springframework.stereotype.Component;
import org.springframework.web.util.HtmlUtils;
import rw.oupay.common.AppProperties;

/**
 * Plain-text and HTML bodies for every transactional message. Every value that reaches the HTML is
 * escaped. Links are built from the configured application URL plus an opaque token, so a message
 * never contains anything a recipient could not already know.
 */
@Component
public class EmailTemplates {

    private final AppProperties app;

    public EmailTemplates(AppProperties app) {
        this.app = app;
    }

    public EmailContent passwordReset(String fullName, String token, Duration validFor) {
        String link = app.link("/reset-password/" + token);
        return render("Reset your OuPay password", fullName,
                "We received a request to reset the password of your OuPay account.",
                "Reset password", link,
                "This link works once and expires in " + describe(validFor)
                        + ". If you did not ask for this, ignore this message: your password has not changed.");
    }

    public EmailContent passwordChanged(String fullName) {
        return render("Your OuPay password was changed", fullName,
                "The password of your OuPay account was just changed, and you were signed out of every device.",
                null, null,
                "If this was not you, reset your password straight away and contact your business owner.");
    }

    public EmailContent emailVerification(String fullName, String token, Duration validFor) {
        String link = app.link("/verify-email/" + token);
        return render("Confirm your OuPay email address", fullName,
                "Please confirm that this is your email address.",
                "Confirm email address", link,
                "This link works once and expires in " + describe(validFor) + ".");
    }

    public EmailContent staffInvitation(String inviteeName, String inviterName, String businessName, String roleLabel,
                                        String note, String token, Duration validFor) {
        String link = app.link("/accept-invitation/" + token);
        String intro = inviterName + " invited you to join " + businessName + " on OuPay as " + roleLabel + "."
                + (note == null || note.isBlank() ? "" : " They wrote: \"" + note.strip() + "\"");
        return render("You are invited to join " + businessName + " on OuPay", inviteeName, intro,
                "View invitation", link,
                "This invitation works once and expires in " + describe(validFor)
                        + ". If you were not expecting it, ignore this message.");
    }

    private static EmailContent render(String subject, String name, String intro, String buttonLabel, String link, String footer) {
        String greeting = name == null || name.isBlank() ? "Hello," : "Hello " + name.strip() + ",";
        StringBuilder text = new StringBuilder(greeting).append("\n\n").append(intro).append("\n\n");
        StringBuilder html = new StringBuilder("<!doctype html><html><body style=\"font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5\">")
                .append("<p>").append(HtmlUtils.htmlEscape(greeting)).append("</p>")
                .append("<p>").append(HtmlUtils.htmlEscape(intro)).append("</p>");
        if (link != null) {
            text.append(buttonLabel).append(": ").append(link).append("\n\n");
            html.append("<p><a href=\"").append(HtmlUtils.htmlEscape(link)).append("\" style=\"display:inline-block;padding:10px 18px;")
                    .append("background:#0f766e;color:#ffffff;text-decoration:none;border-radius:6px\">")
                    .append(HtmlUtils.htmlEscape(buttonLabel)).append("</a></p>")
                    .append("<p style=\"font-size:12px;color:#6b7280\">If the button does not work, copy this address into your browser:<br>")
                    .append(HtmlUtils.htmlEscape(link)).append("</p>");
        }
        text.append(footer).append("\n\nOuPay");
        html.append("<p style=\"font-size:13px;color:#6b7280\">").append(HtmlUtils.htmlEscape(footer)).append("</p><p>OuPay</p></body></html>");
        return new EmailContent(subject, text.toString(), html.toString());
    }

    private static String describe(Duration duration) {
        long hours = duration.toHours();
        if (hours >= 48 && hours % 24 == 0) {
            return (hours / 24) + " days";
        }
        if (hours >= 1) {
            return hours + (hours == 1 ? " hour" : " hours");
        }
        long minutes = Math.max(1, duration.toMinutes());
        return minutes + (minutes == 1 ? " minute" : " minutes");
    }
}
