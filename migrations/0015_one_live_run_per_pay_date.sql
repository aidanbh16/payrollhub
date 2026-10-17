-- One live payroll run per tenant and pay date (RT-01, L2-13; Assignment 5, Section 2.4). ACH idempotency is per run;
-- this is the per-pay-period half, so two runs for the same pay date can never both be approved, computed, and sent.
-- Failed runs are excluded, so D35's "create a new run" path still works after a run fails. Payroll Engine and Payroll
-- Approval check the same rule first and answer 409; this index is the backstop for any other writer.
CREATE UNIQUE INDEX `payroll_run_one_live_per_pay_date` ON `payroll_run` (`tenant_id`, `pay_date`) WHERE `status` <> 'failed';
