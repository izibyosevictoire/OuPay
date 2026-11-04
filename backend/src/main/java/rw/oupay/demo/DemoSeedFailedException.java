package rw.oupay.demo;

import org.springframework.boot.ExitCodeGenerator;

/**
 * The one-shot demonstration seed refused or failed. It carries the process exit status itself ({@link ExitCodeGenerator}), so Spring Boot's own
 * start-up failure handling ends the command with a NON-ZERO status, with no direct call to {@code System.exit} anywhere in the application.
 * The message is the seeder's refusal text, which never contains a secret.
 */
final class DemoSeedFailedException extends RuntimeException implements ExitCodeGenerator {

    /** The exit status of a refused or failed seed. */
    static final int EXIT_CODE = 1;

    DemoSeedFailedException(RuntimeException cause) {
        super("The demonstration seed did not run: " + cause.getMessage(), cause);
    }

    @Override
    public int getExitCode() {
        return EXIT_CODE;
    }
}
