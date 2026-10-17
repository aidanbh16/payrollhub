import { sqliteView } from "drizzle-orm/sqlite-core";
import * as c from "./tables";

// Read-only views over the base tables, created in migrations/ (0001_tenant_isolation.sql).
// Each tenant view returns only rows whose tenant_id equals current_tenant(); v_service_grant returns rows
// only inside a platform scope. The ORM reads exclusively from these views (Assignment 5, Section 3.4).
export const vTenant = sqliteView("v_tenant", c.tenantColumns()).existing();
export const vAppUser = sqliteView("v_app_user", c.appUserColumns()).existing();
export const vSession = sqliteView("v_session", c.sessionColumns()).existing();
export const vTenantIdpConfig = sqliteView("v_tenant_idp_config", c.tenantIdpConfigColumns()).existing();
export const vEmployee = sqliteView("v_employee", c.employeeColumns()).existing();
export const vPayrollRun = sqliteView("v_payroll_run", c.payrollRunColumns()).existing();
export const vApprovalToken = sqliteView("v_approval_token", c.approvalTokenColumns()).existing();
export const vPayResult = sqliteView("v_pay_result", c.payResultColumns()).existing();
export const vBankAccount = sqliteView("v_bank_account", c.bankAccountColumns()).existing();
export const vBankAccountChange = sqliteView("v_bank_account_change", c.bankAccountChangeColumns()).existing();
export const vVerificationCode = sqliteView("v_verification_code", c.verificationCodeColumns()).existing();
export const vAchBatch = sqliteView("v_ach_batch", c.achBatchColumns()).existing();
export const vSsoAssertion = sqliteView("v_sso_assertion", c.ssoAssertionColumns()).existing();
export const vPayException = sqliteView("v_pay_exception", c.payExceptionColumns()).existing();
export const vServiceTokenUse = sqliteView("v_service_token_use", c.serviceTokenUseColumns()).existing();

export const vServiceGrant = sqliteView("v_service_grant", c.serviceGrantColumns()).existing();
