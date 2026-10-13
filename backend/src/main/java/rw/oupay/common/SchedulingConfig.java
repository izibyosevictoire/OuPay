package rw.oupay.common;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Background work (the e-mail dispatcher, housekeeping). Jobs are safe to run on several instances. */
@Configuration
@EnableScheduling
public class SchedulingConfig {}
