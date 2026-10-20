# Runbook: Rebuild Salesforce + Amazon Connect Lab from Git

A step-by-step operational guide to rebuild, configure, verify, and tear down the hybrid Salesforce and Amazon Connect CCaaS integration lab.

---

## Prerequisites & Checklist

Before starting, ensure you have the following prerequisites prepared:

### 1. Local Tools & Environment
- **Git** & **VS Code**
- **Node.js** (v18 or newer)
- **Salesforce CLI (`sf`)** installed and authenticated
- Web browser with popups allowed for Salesforce and CCP windows
- OpenSSL (for key/certificate generation)

### 2. Salesforce Org
- A Salesforce Developer Edition org (or scratch org) with **My Domain** configured.
- System Administrator access.

### 3. AWS Account & Security Guardrails
- Dedicated AWS account for lab use.
- **Root Account**: Protected with Multi-Factor Authentication (MFA).
- **IAM Admin User**: Daily operations performed via an IAM Admin user (or IAM Identity Center) — avoid using root.
- **Budget Alert**: Monthly AWS budget (~$5 USD) configured in **AWS Billing > Budgets** with email notifications.
- **Single Region**: Standardize on a single region that supports Amazon Connect (e.g., `ap-southeast-2` Sydney) so Connect, Lambda, and Secrets Manager co-locate.

### 4. Working Notes
- Keep a local scratchpad ready to track dynamic variables (e.g., URLs, IDs, ARNs, Keys) generated during setup (see [Dynamic Environment Values](#dynamic-environment-values)).

---

## Part 1: Salesforce Configuration (Core Foundation)

> [!IMPORTANT]
> Complete the Salesforce configuration first to generate the endpoint credentials and certificate required by AWS Lambda and Amazon Connect.

### Step 1.1: Clone & Authenticate

1. Clone the repository and navigate to the directory where `sfdx-project.json` is located:
   ```bash
   cd salesforce
   ```
2. Log in and set the target org alias:
   ```bash
   sf org login web --alias ccaas-dev --set-default
   ```

### Step 1.2: Deploy Metadata & Run Tests

1. Deploy the project metadata (Apex, triggers, LWCs, Platform Events, Custom Metadata, custom fields, and Permission Sets):
   ```bash
   sf project deploy start --source-dir force-app --target-org ccaas-dev
   ```
2. Run the test suite:
   ```bash
   sf apex run test --class-names ConnectDialerTest --result-format human --wait 10
   ```
   > [!NOTE]
   > The test suite requires a `Connect_Setting` Custom Metadata record named `Default`. If not included in the deployment, create it manually in **Setup > Custom Metadata Types > Connect Setting > Manage Records** with placeholder values.

3. Assign the required permission sets:
   ```bash
   # Assign outbound calling permissions to your admin user
   sf org assign permset --name Connect_Outbound

   # Assign lookup permissions to the integration user
   sf org assign permset --name Connect_Lookup_Read --on-behalf-of <integration-username>
   ```

---

### Step 1.3: Generate Certificates & Configure JWT App

#### A. Generate RSA Keypair
Run OpenSSL locally to produce a self-signed certificate and base64-encoded private key:

```bash
# Generate 2048-bit RSA private key and self-signed certificate (valid 365 days)
openssl req -x509 -nodes -newkey rsa:2048 -keyout server.key -out server.crt -days 365 -subj '/CN=connect-lambda-lab'

# Encode private key to a single-line base64 string for AWS Lambda
base64 -w0 server.key > server.key.b64
```

#### B. Create Connected App / External Client App in Salesforce
1. Navigate to **Setup > App Manager > New Connected App** (or create an **External Client App** if enabled).
2. Configure basic settings:
   - **Connected App Name**: `Connect Lambda JWT`
   - **Contact Email**: your admin email
3. Configure OAuth settings:
   - Check **Enable OAuth Settings**.
   - **Callback URL**: `https://localhost/callback` *(required by UI, unused by JWT)*.
   - Check **Use digital signatures** and upload `server.crt`.
   - **Selected OAuth Scopes**:
     - `Manage user data via APIs (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
     > [!WARNING]
     > Both scopes are required. Omitting `refresh_token, offline_access` will cause newer orgs to reject JWT requests with: `invalid_request: refresh_token scope is required`.
4. Click **Save** and copy the generated **Consumer Key** (Client ID). *(Note: Changes may take 2–5 minutes to replicate.)*
5. Configure App Policies:
   - Click **Manage > Edit Policies**.
   - Under **OAuth Policies > Permitted Users**, select: **Admin approved users are pre-authorized**.
   - Save, scroll down to **Permission Sets**, and click **Manage Permission Sets**.
   - Add `Connect_Lookup_Read`. Only users with this permission set can authenticate via this app.

---

### Step 1.4: Seed Test Data

Create test records required for contact lookup and screen-pop validation:

1. **Account**: Create a test Account (e.g., `Acme Lab`).
2. **Contact**: Create a Contact under the Account:
   - **Name**: `Test Caller`
   - **Customer Number (`Customer_Number__c`)**: `1001`
   - **Phone**: Your phone number in E.164 format (e.g., `+61400000000`)
   - **Mobile**: Same E.164 number in `MobilePhone`
3. **Case**: Create an open Case linked to the `Test Caller` Contact with Status `New` or `Working`.

---

### Step 1.5: Configure Open CTI Call Center & GitHub Pages Softphone

1. **Import Call Center Definition**:
   - Go to **Setup > Call Centers**.
   - Click **Import** and select `call-center/LabCCaaS.xml`.
   - *(Optional)* If your GitHub username or repo changed, edit the `<reqURL>` adapter URL inside `LabCCaaS.xml` before importing.
   - Click **Manage Call Center Users > Add More Users**, and assign your user.
   > [!NOTE]
   > A Salesforce user can belong to only one call center at a time. If you previously assigned yourself to `AC Lightning Adapter`, remove that assignment first.
2. **Softphone Layout**:
   - Go to **Setup > Softphone Layouts**. Ensure the default layout has **Contact** searchable and screen-pop behavior configured.
3. **Utility Bar Setup**:
   - Go to **Setup > App Manager > Service Console (Edit) > Utility Items**.
   - Ensure **Open CTI Softphone** is added.
   - Add the `escalationBanner` custom LWC (set to start automatically).
4. **Publish GitHub Pages CCP Host**:
   - In GitHub repository **Settings > Pages**, set Source to branch `main` and folder `/docs`.
   - Verify `docs/index.html` references the correct Salesforce Lightning domain for `opencti_min.js`.

---

### Step 1.6: Local Lambda Verification (Pre-AWS Sanity Check)

Validate your JWT authentication and Salesforce SOQL query locally before deploying to AWS:

```bash
cd lambda/sfCustomerLookup

# Set environment variables for local test
export SF_LOGIN_URL='https://login.salesforce.com'
export SF_CLIENT_ID='<your-consumer-key>'
export SF_USERNAME='<integration-username>'
export SF_PRIVATE_KEY_B64="$(cat ../../server.key.b64)"

# Invoke handler locally
node --input-type=module -e "import('./index.mjs').then(m => m.handler({ Details: { ContactData: { CustomerEndpoint: { Address: '+61400000000' } }, Parameters: { customerNumber: '1001' } } })).then(console.log)"
```

- **Expected Output**: `{ found: 'true', contactId: '003...', ... }`
- **Troubleshooting**: If you receive `invalid_request: refresh_token scope is required`, verify both OAuth scopes (`api` and `refresh_token, offline_access`) are enabled on the Connected App, and that the integration user has `Connect_Lookup_Read` assigned under App Policies.

---

## Part 2: AWS & Amazon Connect (Custom Implementation)

### Step 2.1: AWS Account & Cost Guardrails
1. Sign in to the AWS Console using your **IAM Admin user**.
2. Select your designated region (e.g., `ap-southeast-2` Sydney). All resources (Connect, Lambda, Secrets Manager) must reside in this region.
3. Verify that the **AWS Budget** alert (~$5 USD) is active under **Billing > Budgets**.

### Step 2.2: Amazon Connect Instance Setup
1. Open the **Amazon Connect** console and click **Add an instance**.
   - **Identity management**: Store users within Amazon Connect.
   - **Access URL**: Choose a unique alias (e.g., `ccaas-lab-<your-initials>`).
2. Complete setup and open the Connect Administration console.
3. Configure core telephony & routing entities:
   - **Phone Number** *(Optional / if testing voice)*: Go to **Channels > Phone numbers** and claim a DID number.
   - **Queue**: Create `SalesforceLabQueue`.
   - **Routing Profile**: Create `LabAgents` (associate with `SalesforceLabQueue`, Voice and Chat channels enabled).
   - **User**: Create agent user `lab.agent` assigned to `LabAgents` profile.

### Step 2.3: Contact Flows Setup
1. Navigate to **Routing > Flows**.
2. Import contact flows from `exports/connect/` (if flow designer supports import):
   - `LabInbound`
   - `LabInboundLookup`
   - `LabChatLookup`
   - `LabCallback`
3. **Re-link Dynamic Blocks**: Since queue and Lambda IDs are unique per instance, open each imported flow and re-select:
   - The appropriate Queue (`SalesforceLabQueue`) in the *Set working queue* blocks.
   - The Customer Lookup Lambda function in the *Invoke AWS Lambda* blocks.
4. Save and **Publish** each flow.

### Step 2.4: Approved Origins (CORS & Embedding)
1. In the AWS Console, open your **Amazon Connect Instance settings**.
2. Select **Application integration > Approved origins > Add origin**.
3. Add the following URLs:
   - `https://<your-my-domain>.develop.lightning.force.com`
   - `https://<github-username>.github.io`
   - `https://<your-my-domain>.develop.my.salesforce.com` *(required if CCP panel stays blank)*

### Step 2.5: Deploy Customer Lookup Lambda
1. Open **AWS Lambda** console and create a new function:
   - **Function Name**: `sfCustomerLookup`
   - **Runtime**: `Node.js 22.x` (or latest supported LTS)
   - **Architecture**: `x86_64` or `arm64`
   - **Memory**: `256 MB`
   - **Timeout**: `8 seconds`
2. Paste the source code from `lambda/sfCustomerLookup/index.mjs`.
3. Configure **Configuration > Environment variables**:
   - `SF_LOGIN_URL`: `https://login.salesforce.com`
   - `SF_CLIENT_ID`: `<Consumer Key from Connected App>`
   - `SF_USERNAME`: `<Salesforce Integration Username>`
   - `SF_PRIVATE_KEY_B64`: `<Contents of server.key.b64>`
4. Deploy the function.
5. **Grant Connect Access**:
   - Return to the Amazon Connect Console > your instance > **Contact flows > AWS Lambda**.
   - Select `sfCustomerLookup` and click **Add Lambda Function**.
6. Run a test event in the Lambda console using the payload tested in Step 1.6 to verify execution.

### Step 2.6: Configure GitHub Pages CCP Softphone
1. In your local repository, edit `docs/config.js`:
   ```javascript
   const CCP_URL = "https://<your-instance-alias>.my.connect.aws/ccp-v2/";
   const REGION = "ap-southeast-2";
   ```
2. Commit and push changes to `main`. Wait for GitHub Pages deployment to complete.

### Step 2.7: End-to-End Verification

#### A. Inbound / Chat Verification
1. Log in to Salesforce Service Console and ensure the Open CTI softphone utility item is visible and authenticated.
2. In Amazon Connect Console, open **Dashboard > Test chat > Test Settings**:
   - Select flow: `LabChatLookup`.
   - Add customer attribute:
     - Key: `customerNumber`, Value: `1001` (or Key: `sfContactId`, Value: `003...`).
   - Click **Apply** and initiate chat.
3. **Verify**:
   - Contact record `Test Caller` screen-pops in Salesforce.
   - Contact flow greets with case details.
   - Ending chat generates a completed `Task` record on the Contact.

#### B. Outbound Voice Dialing *(Only if a phone number was claimed)*
1. **AWS IAM User**:
   - Create IAM user `sf-connect-outbound` with programmatic access.
   - Attach policy with permission: `connect:StartOutboundVoiceContact`.
   - Save Access Key ID and Secret Access Key.
2. **Salesforce External & Named Credentials**:
   - **External Credential**: Update `AWS_Connect_Outbound` (Principal: `LabPrincipal`, AWS Region, Service: `connect`) with the IAM access keys.
   - **Named Credential**: Confirm `Amazon_Connect_API` targets the correct region endpoint.
3. **Custom Metadata**:
   - Update `Connect_Setting.Default` with:
     - `Instance_Id__c`: Amazon Connect Instance ID
     - `Contact_Flow_Id__c`: Flow ID of `LabCallback`
     - `Source_Phone_Number__c`: Your claimed E.164 phone number
4. **Test**: Click the **Call** button on the `Test Caller` Contact record in Salesforce.

---

### Step 2.8: Session Wrap-up & Teardown

> [!CAUTION]
> To avoid unnecessary AWS charges, always tear down cloud resources at the end of each lab session.

1. **Backup Artefacts**:
   - Export modified Connect flows to `exports/connect/`.
   - Record non-sensitive stack parameters in `exports/parameters.md`.
   - Take verification screenshots.
2. **AWS Teardown Checklist**:
   - [ ] Release any claimed phone numbers in Connect (**Channels > Phone numbers**).
   - [ ] Delete the Amazon Connect instance.
   - [ ] Delete `sfCustomerLookup` Lambda function.
   - [ ] Delete Secrets Manager secrets and customer-managed KMS keys.
   - [ ] Delete IAM user `sf-connect-outbound` and access keys.
   - [ ] Delete CloudFormation stacks (if any were deployed).
3. **Salesforce Teardown**:
   - [ ] Remove or deactivate the `sf-connect-outbound` Named Credential.
4. **Post-Cleanup Verification**:
   - Check the **AWS Billing > Cost Explorer** dashboard on the following day to confirm $0 ongoing burn rate.

---

## Part 3: Alternative Managed Package (Amazon Connect CTI Adapter)

> [!NOTE]
> This section covers the official AppExchange managed CTI Adapter, which is an alternative to the custom GitHub Pages CCP implementation. Remember that a Salesforce user can belong to only **one** Call Center definition at a time.

1. **Install Package**: Install **Amazon Connect CTI Adapter** from Salesforce AppExchange (Admins only).
2. **Deploy SAR Stack**: In AWS, deploy `AmazonConnectSalesForceLambda` from the Serverless Application Repository with default parameters.
3. **Create Named Credential**:
   - Create IAM user with `invokeSfExecuteAWSServicePolicy` and generate access keys.
   - In Salesforce, configure Named Credential `ExecuteAwsService` pointing to the Lambda service.
4. **Configure Connected App**:
   - Create Connected App with OAuth Client Credentials flow.
   - Assign an integration API user as Run As.
   - Pre-authorize permission set `AC_Administrator`.
   - Store Consumer Key and Secret in AWS Secrets Manager.
5. **Guided Setup**:
   - In Salesforce Service Console, launch **AC Guided Setup**.
   - Set CloudFormation stack parameter `SalesforceAuthMode` to `client_credentials`.
   - Verify login requests in Salesforce **Setup > Login History** resolve to your My Domain.
6. **Assign Agent & Switch Call Center**:
   - Add your Lightning domain to Connect **Approved Origins**.
   - Add **Open CTI Softphone** utility item to the Service Console.
   - Assign `AC_Agent` permission set.
   - Move your Salesforce user from `LabCCaaS` to `AC Lightning Adapter` in **Setup > Call Centers**.
7. **Tear Down**:
   - When finished, disable the `sfExecuteAWSService` Lambda function and delete the IAM credentials.

---

## Reference & Appendices

### Non-Git Configuration Checklist

The following items are not tracked in Git and must be configured manually upon rebuilding:

| Item | Category | Reason Not in Git | Configuration Steps |
| :--- | :--- | :--- | :--- |
| **Private Key & Certificate** | Security | Secrets / Cryptographic material | Generate using `openssl`; upload `.crt` to Connected App; base64-encode `.key` for Lambda. |
| **Connected App / External Client App** | Security / Auth | Org-specific OAuth client configuration | Configure with `api` and `refresh_token, offline_access` scopes; pre-authorize `Connect_Lookup_Read`. |
| **Test Data** | Application Data | Records exist in database storage | Create 1 Account, 1 Contact (`1001`, E.164 mobile), and 1 open Case. |
| **Softphone Layout** | Call Center | Org UI preference | Set default layout; enable Contact search; set un-matched behavior to "Don't pop". |
| **Utility Bar Items** | Lightning Experience | App navigation configuration | Add **Open CTI Softphone** and `escalationBanner` LWC to the Service Console. |
| **Named Credential Keys** | Security | IAM secret access keys | Re-enter AWS IAM access keys in External / Named Credentials. |

---

### Dynamic Environment Values

Values that change every time you rebuild the lab environment:

| Variable / Setting | Affected Locations | Description |
| :--- | :--- | :--- |
| **Connect Access URL & CCP URL** | `docs/config.js`, Custom Settings, Guided Setup | Base URL for your newly provisioned Connect instance. |
| **Approved Origins** | Amazon Connect Instance > Application Integration | Salesforce My Domain and GitHub Pages origins. |
| **Instance ID & Contact Flow IDs** | Salesforce `Connect_Setting.Default` record | Unique UUIDs generated by AWS on resource creation. |
| **Claimed Phone Number** | Salesforce `Connect_Setting.Default`, Connect Queue | E.164 DID phone number claimed in Connect. |
| **AWS IAM Access Keys** | Salesforce `ExecuteAwsService` & `AWS_Connect_Outbound` | New access keys generated for programmatic access. |
| **Lambda & Secret ARNs** | SAR Stack parameters, Contact Flow Lambda blocks | Dynamic Amazon Resource Names for new functions. |
| **Agent Login** | CCP Browser Pop-up | Agent credential authentication session. |

---

## Smoke Test Checklist

Use this checklist to validate system readiness:

- [ ] **Apex Tests**: `sf apex run test --class-names ConnectDialerTest` passes with 100% success.
- [ ] **Local Lambda**: Local execution via `node` returns `{ found: 'true' }`.
- [ ] **CTI Softphone Load**: Open CTI softphone loads in Salesforce Service Console utility bar.
- [ ] **Agent Authentication**: Successfully authenticate to CCP within the utility bar.
- [ ] **Screen-Pop & Task**: Test chat matches `1001`, screen-pops Contact `Test Caller`, and ending chat logs a `Task`.
- [ ] **IVR / Case Status**: Contact flow correctly greets and reads Case status.
- [ ] **LWC Escalation Banner**: Escalating a Case displays the real-time notification toast.
- [ ] **Click-to-Dial**: Outbound call initiates when clicking the Call button on a Contact (if voice is enabled).
- [ ] **Teardown Completed**: Phone numbers released, Connect instance deleted, and AWS resources cleaned up.

