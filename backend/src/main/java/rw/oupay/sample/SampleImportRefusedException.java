package rw.oupay.sample;

import org.springframework.boot.ExitCodeGenerator;

/**
 * The importer refused, or a step failed. It carries the process exit status itself ({@link ExitCodeGenerator}), so Spring Boot's own start-up
 * failure handling ends the command with a NON-ZERO status, with no direct call to {@code System.exit}. The message never contains a secret.
 */
public final class SampleImportRefusedException extends RuntimeException implements ExitCodeGenerator {

    private static final long serialVersionUID = 1L;

    /** The exit status of a refused or failed import. */
    static final int EXIT_CODE = 1;

    SampleImportRefusedException(String why) {
        super("Refusing to import sample data: " + why);
    }

    SampleImportRefusedException(String why, Throwable cause) {
        super("Sample data import stopped: " + why, cause);
    }

    @Override
    public int getExitCode() {
        return EXIT_CODE;
    }
}
