# Scalable Web Application on AWS with ALB, Auto Scaling and Multi-AZ RDS

A highly available and secure web application on AWS that scales automatically with traffic.

> Graduation project for Manara’s “AWS 2: Becoming a Solutions Architect” course. This repository documents the architecture.

## Table of contents

- [Solution overview](#solution-overview)
- [Architecture diagram](#architecture-diagram)
- [Request flow](#request-flow)
- [AWS services and why each was chosen](#aws-services-and-why-each-was-chosen)
- [Network design](#network-design)
- [Load balancer](#load-balancer)
- [Security](#security)
- [High availability and failure scenarios](#high-availability-and-failure-scenarios)
- [Scaling](#scaling)
- [Monitoring and alerting](#monitoring-and-alerting)
- [Design decisions](#design-decisions)
- [Deployment overview](#deployment-overview)
- [Repository structure](#repository-structure)

## Solution overview

A web application must stay available when a server or a whole Availability Zone fails, stay fast when traffic grows, and keep its servers and data away from direct internet access. Running the application on a single server meets none of these needs: one failure stops the service and extra traffic slows it down.

This solution runs the application on Amazon EC2 instances in private subnets across two Availability Zones in eu-central-1 (Frankfurt). An Auto Scaling group adds or removes instances as load changes and replaces unhealthy ones. User traffic reaches the instances only through Amazon CloudFront, which caches static files at edge locations, and an Application Load Balancer protected by AWS WAF. Data is stored in Amazon RDS for PostgreSQL with a Multi-AZ standby, so the database fails over automatically if the primary fails. Administrators reach the instances through AWS Systems Manager Session Manager, without SSH keys, open inbound ports or a bastion host.

The example workload is a simple Notes application (Node.js and PostgreSQL) in the [app/](app/) folder: a single page, static files under `/static/*`, and a small REST API under `/api/notes`. The application is stateless, so any instance can serve any request. 

## Architecture diagram

![Architecture diagram](docs/architecture.png)

## Request flow

The numbers below match the numbered arrows in the architecture diagram.

1. **DNS lookup:** the browser asks Route 53 for the address of `notes.example.com`. Route 53 returns the address of the nearest CloudFront edge location. It only answers the DNS query; the request itself does not pass through it.
2. **HTTPS to CloudFront:** the browser sends the request to the edge location.
   - Requests for `/static/*` (CSS and JavaScript) are answered from the CloudFront cache. If the file is not in the cache yet, CloudFront gets it from the ALB once and keeps a copy.
   - All other requests (`/` and `/api/*`) are not cached and go to step 3.
3. **CloudFront to the ALB:** CloudFront forwards the request to the ALB through the Internet Gateway, with a secret custom header. Before the request is routed, it passes three checks:
   - The ALB security group accepts traffic only from CloudFront.
   - AWS WAF blocks common attacks such as SQL injection and cross-site scripting.
   - An ALB listener rule rejects requests without the custom header.
4. **ALB to EC2:** the ALB sends the request to a healthy instance in either Availability Zone.
5. **EC2 to RDS:** for `/api/notes`, the application reads from or writes to the RDS primary database. For `/` and `/static/*`, EC2 returns the file directly, without the database.
6. **Response:** the response goes back the same way to the browser.

Traffic that the instances start themselves, such as software updates and Session Manager, goes out through the NAT Gateway. It is not part of the user request path.

## AWS services and why each was chosen

| Service | Role in this solution | Why this service |
| --- | --- | --- |
| Amazon VPC | Private network for all resources | Keeps servers and the database off the internet |
| Security groups + Network ACLs | Firewalls for instances and subnets | Security groups allow only the needed traffic between tiers; NACLs add a second layer at the subnet level |
| Amazon EC2 + Auto Scaling | Runs the application | Adds instances when traffic grows and replaces failed ones |
| Application Load Balancer | Spreads traffic across instances | Sends requests only to healthy instances in both AZs |
| AWS WAF | Filters requests before the ALB | Blocks common web attacks at layer 7 |
| Amazon CloudFront | Delivers the site and caches static files | Faster for users, less load on the servers |
| Amazon RDS for PostgreSQL (Multi-AZ) | Stores the data | Automatic failover to a standby in another AZ |
| Amazon Route 53 | DNS for notes.example.com | Points the domain to CloudFront |
| AWS Systems Manager (Session Manager) | Access to the instances | No SSH keys, no open ports, no bastion host |
| Amazon CloudWatch + Amazon SNS | Monitoring and alerts | Sends an email when something goes wrong |
| NAT Gateway | Outbound internet for private instances | Updates and Systems Manager access, one per AZ for high availability |

## Network design

**Region:** eu-central-1 (Frankfurt) · **VPC CIDR:** 10.0.0.0/16

| Subnet | AZ | CIDR | Type | Contains |
| --- | --- | --- | --- | --- |
| public-a | eu-central-1a | 10.0.1.0/24 | Public | ALB node, NAT Gateway |
| public-b | eu-central-1b | 10.0.2.0/24 | Public | ALB node, NAT Gateway |
| app-a | eu-central-1a | 10.0.11.0/24 | Private | EC2 instances |
| app-b | eu-central-1b | 10.0.12.0/24 | Private | EC2 instances |
| data-a | eu-central-1a | 10.0.21.0/24 | Private | RDS primary |
| data-b | eu-central-1b | 10.0.22.0/24 | Private | RDS standby |

### Route tables

| Route table | Associated subnets | Destination | Target |
| --- | --- | --- | --- |
| public-rt | public-a, public-b | 0.0.0.0/0 | Internet Gateway |
| app-rt-a | app-a | 0.0.0.0/0 | NAT Gateway (AZ a) |
| app-rt-b | app-b | 0.0.0.0/0 | NAT Gateway (AZ b) |
| data-rt | data-a, data-b | Local only | — |

- **Public subnets** route `0.0.0.0/0` to the Internet Gateway. Only the ALB nodes and the NAT Gateways live here, because they are the only resources that must be reachable from, or reach, the internet directly.
- **App subnets** route `0.0.0.0/0` to the NAT Gateway in the same Availability Zone. The instances can start outbound connections (software updates, Session Manager), but nothing on the internet can start a connection to them. Each AZ has its own NAT Gateway and route table, so if one AZ fails, the instances in the other AZ keep their outbound access.
- **Data subnets** have no internet route, only the local VPC route. The database needs to talk only to the application instances in the same VPC, and RDS is a managed service, so AWS applies patches, takes backups and handles failover without the database needing internet access. Without an internet route, even if the database were compromised, data could not be sent out of the VPC directly.

## Load balancer

The ALB is internet-facing, with a node in each public subnet.

### Listener rules

| Listener | Priority | Condition | Action |
| --- | --- | --- | --- |
| HTTPS 443 (ACM certificate) | 1 | Header `X-Origin-Verify` equals the secret value set in CloudFront | Forward to `notes-tg` |
| HTTPS 443 | Default | Any other request | Return fixed response 403 |

Only CloudFront knows the header value, so requests that reach the ALB directly are rejected.

### Target group `notes-tg`

| Setting | Value |
| --- | --- |
| Target type / protocol / port | Instance / HTTP / 3000 |
| Health check path | `/healthz` |
| Interval / timeout | 15 seconds / 5 seconds |
| Healthy / unhealthy threshold | 2 / 2 |
| Success code | 200 |
| Deregistration delay | 30 seconds |

`/healthz` does not query the database, so a database failover does not make the instances look unhealthy and does not trigger instance replacement. The deregistration delay lets in-flight requests finish before an instance is removed.

## Security

### Layers of defense

Each layer protects the application even if the layer before it fails or is misconfigured. From the edge inward:

1. **CloudFront:** the only public entry point. Serves HTTPS only and hides the ALB from users.
2. **AWS WAF:** blocks common web attacks (OWASP Top 10) and limits how many requests one IP address can send.
3. **ALB security group and listener rule:** accept traffic only from CloudFront, and only with the secret custom header.
4. **Private subnets:** the instances and the database have no public IP addresses and cannot be reached from the internet.
5. **App and database security groups:** each tier accepts traffic only from the tier in front of it.
6. **Network ACLs:** a second, subnet-level filter in case a security group is misconfigured.
7. **IAM and Session Manager:** no SSH keys or open admin ports; instances get only the permissions they need.
8. **Encryption:** data is encrypted in transit (TLS) and at rest (KMS).

### Security group chain

| Security group | Attached to | Inbound | Source | Outbound |
| --- | --- | --- | --- | --- |
| alb-sg | ALB | HTTPS 443 | CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) | TCP 3000 to app-sg |
| app-sg | EC2 instances | TCP 3000 | alb-sg | PostgreSQL 5432 to db-sg; HTTPS 443 to the internet through NAT (updates, Session Manager) |
| db-sg | RDS | PostgreSQL 5432 | app-sg | None |

Rules use security group IDs as sources instead of IP ranges. Instances in the Auto Scaling group are created and replaced all the time, so their IP addresses change. A rule that references a security group follows its members automatically, so a new instance can reach the database as soon as it starts, and nothing else can.

There is no inbound rule for SSH (port 22) on any group. Administrators use Session Manager instead (see [Instance access and permissions](#instance-access-and-permissions)).

Security groups are stateful: return traffic for an allowed connection is allowed automatically. This is why db-sg needs no outbound rule.

### Network ACLs

Security groups are the main filter. Network ACLs add a second, subnet-level layer around the most sensitive tier, the database.

- Public and app subnets use the default network ACL, which allows all traffic. Their protection comes from the security group chain.
- Data subnets use a custom network ACL (`data-nacl`):

| Direction | Rule # | Protocol / ports | Source / destination | Action |
| --- | --- | --- | --- | --- |
| Inbound | 100 | TCP 5432 | 10.0.11.0/24 (app-a) | Allow |
| Inbound | 110 | TCP 5432 | 10.0.12.0/24 (app-b) | Allow |
| Inbound | 120 | All | 10.0.21.0/24 (data-a) | Allow |
| Inbound | 130 | All | 10.0.22.0/24 (data-b) | Allow |
| Inbound | * | All | 0.0.0.0/0 | Deny |
| Outbound | 100 | TCP 1024–65535 | 10.0.11.0/24 (app-a) | Allow |
| Outbound | 110 | TCP 1024–65535 | 10.0.12.0/24 (app-b) | Allow |
| Outbound | 120 | All | 10.0.21.0/24 (data-a) | Allow |
| Outbound | 130 | All | 10.0.22.0/24 (data-b) | Allow |
| Outbound | * | All | 0.0.0.0/0 | Deny |

Network ACLs are stateless: return traffic is not allowed automatically. When an instance connects to the database on port 5432, the reply goes back to a random ephemeral port on the instance (1024–65535), so the outbound rules must allow that range. Rules 120 and 130 keep traffic between the two data subnets open for the RDS primary and standby. If a security group rule is ever opened by mistake, this ACL still blocks any traffic to the database that does not come from the app subnets.

### AWS WAF rules


A web ACL is attached to the ALB. Rules are evaluated in priority order:

| Priority | Rule | Type | What it blocks |
| --- | --- | --- | --- |
| 1 | `AWSManagedRulesCommonRuleSet` | AWS managed | Common OWASP Top 10 attacks, such as cross-site scripting and bad request formats |
| 2 | `AWSManagedRulesKnownBadInputsRuleSet` | AWS managed | Request patterns known to exploit vulnerabilities |
| 3 | `AWSManagedRulesSQLiRuleSet` | AWS managed | SQL injection in query strings, body and cookies |
| 4 | `rate-limit-per-ip` | Rate-based | More than 1,000 requests from one IP address in 5 minutes |

AWS maintains the managed rule groups and updates them as new attack patterns appear, so no custom rules need to be written or maintained. The rate-based rule protects against request floods and brute-force attempts. The SQL injection group matters here because the application stores user input in PostgreSQL.

### Instance access and permissions

Administrators connect to the instances with AWS Systems Manager Session Manager instead of SSH or a bastion host. No inbound ports are open, no SSH keys are needed, and every session is logged.

Each instance has an IAM role with only the permissions it needs:

| Permission | Why |
| --- | --- |
| `AmazonSSMManagedInstanceCore` | Allows Session Manager access |
| Read access to `/notes-app/*` in Parameter Store | Reads the database password at startup |

The database password is stored encrypted in Systems Manager Parameter Store, not in the code. The launch template requires IMDSv2, which protects the role credentials on the instance.

### Encryption

In transit (data moving over the network is encrypted with TLS):

- User to CloudFront (arrow 2): HTTPS only. If a user opens the site with `http://`, CloudFront redirects to `https://`.
- CloudFront to ALB (arrow 3): HTTPS.
- ALB to EC2 (arrow 4): HTTP inside the VPC. This traffic never leaves the private network.
- Application to RDS (arrow 5): the PostgreSQL connection uses TLS.
- Certificates come from AWS Certificate Manager (ACM). The CloudFront certificate is created in us-east-1, as CloudFront requires; the ALB certificate is created in eu-central-1.

At rest (stored data is encrypted with AWS KMS):

- RDS storage, automated backups and snapshots.
- EBS volumes on the instances.
- The database password in Parameter Store.

## High availability and failure scenarios

Every layer runs in two Availability Zones, so no single server or AZ failure stops the application:

- The ALB has a node in each public subnet.
- The Auto Scaling group keeps instances in both app subnets.
- RDS keeps a synchronous standby in the second AZ.
- Each AZ has its own NAT Gateway.

The ALB checks `/healthz` on each instance every 15 seconds and marks it unhealthy after 2 failed checks. The Auto Scaling group uses these ELB health checks, so it replaces any instance the ALB marks unhealthy.

| Failure | What happens | Recovery time | User impact |
| --- | --- | --- | --- |
| One EC2 instance fails | The ALB stops sending traffic to it; the Auto Scaling group launches a replacement | Traffic moves in about 30 seconds; new instance in a few minutes | None, or a few in-flight requests fail |
| Application process crashes, instance still running | systemd restarts the process; if it keeps failing, the instance is replaced as above | About 5 seconds for a restart | None |
| An entire Availability Zone fails | The ALB sends all traffic to the other AZ; the Auto Scaling group launches replacements there; RDS fails over if the primary was in that AZ | About 30 seconds for traffic; a few minutes for full capacity | Slower responses until capacity is restored; API errors during a database failover |
| RDS primary fails | RDS promotes the standby and points the database endpoint to it | 60–120 seconds | `/api/notes` fails during the failover; pages and static files still load; no data is lost |
| One NAT Gateway fails | Instances in that AZ lose outbound internet access (updates, Session Manager) | Until AWS restores it | None; user traffic does not use the NAT Gateway |
| Traffic spike | CloudFront serves static files from cache; Auto Scaling adds instances; the WAF rate-based rule blocks floods from single IPs | A few minutes for new instances | Possibly slower responses for a few minutes |

## Scaling

The Auto Scaling group launches instances from a launch template (AMI, instance type, app-sg, IAM role, IMDSv2) across both app subnets.

| Setting | Value |
| --- | --- |
| Minimum / desired / maximum | 2 / 2 / 6 |
| Health check type | EC2 + ELB, grace period 120 seconds |
| Instance warmup | 120 seconds |

Two scaling policies work together:

| Policy | Type | Rule | Purpose |
| --- | --- | --- | --- |
| `cpu-target-50` | Target tracking | Keep average CPU at 50% | Normal scaling out and in |
| `cpu-spike` | Step scaling (scale out only) | CPU ≥ 80% for 2 minutes: add 2 instances | Faster reaction to a sudden spike |

Target tracking handles everyday changes and is the only policy that removes instances. The step policy adds capacity faster when load jumps suddenly. When both policies want to scale out, Auto Scaling uses the one that adds more capacity.

The minimum of 2 keeps one instance in each Availability Zone at all times. The maximum of 6 limits cost.

The application is stateless: no sessions or files are kept on the instances, and all data is in RDS. Any instance can serve any request, so instances can be added or removed at any time without affecting users.

To release a new version, a new AMI is added to the launch template and an Instance Refresh replaces the instances gradually, keeping enough healthy instances to serve traffic.

## Monitoring and alerting

Amazon CloudWatch collects metrics from the ALB, EC2, Auto Scaling and RDS without extra agents. Alarms send notifications to an Amazon SNS topic, which emails the operations team.

A Route 53 health check requests `https://notes.example.com/healthz` from several locations around the world. It tests the full path a user takes (DNS, CloudFront, WAF, ALB and EC2), not only one component.

### Dashboard

One CloudWatch dashboard shows the health of the whole stack:

| Widget | Metrics |
| --- | --- |
| Traffic | ALB request count, CloudFront requests and cache hit rate |
| Errors | ALB 5XX errors, WAF blocked requests |
| Latency | ALB target response time |
| Capacity | Number of instances in the Auto Scaling group, average EC2 CPU |
| Database | RDS CPU, database connections, free storage space |

### Alarms

| Alarm | Metric | Threshold | Action |
| --- | --- | --- | --- |
| Site down | Route 53 `HealthCheckStatus` | Health check fails for 2 minutes | SNS email |
| Unhealthy instances | ALB `UnHealthyHostCount` | ≥ 1 for 5 minutes | SNS email |
| Application errors | ALB `HTTPCode_Target_5XX_Count` | > 10 in 5 minutes | SNS email |
| Slow responses | ALB `TargetResponseTime` | Average > 1 second for 5 minutes | SNS email |
| High CPU at max capacity | EC2 `CPUUtilization` (group average) | ≥ 80% for 15 minutes | SNS email |
| Database CPU | RDS `CPUUtilization` | ≥ 80% for 10 minutes | SNS email |
| Low database storage | RDS `FreeStorageSpace` | < 2 GB | SNS email |

RDS failover is an event, not a metric, so it cannot trigger a normal alarm. An RDS event subscription sends an SNS email whenever a failover starts or completes.

## Design decisions

| Decision | Chosen option | Reason |
| --- | --- | --- |
| Application | Simple Notes app (Node.js + PostgreSQL) | Small, but has static files, an API and a database |
| Tiers | One app tier behind the ALB | Simpler; the app serves both pages and API |
| Database | RDS for PostgreSQL, Multi-AZ | Automatic failover to another AZ |
| Region | eu-central-1 (Frankfurt) | I chose it because it is the Region I usually work in; this project has no specific requirement for it. In a real project, I would choose the Region based on proximity to users, cost, service availability and compliance requirements. |
| NAT Gateways | One per AZ | One AZ failure does not affect the other |
| WAF | On the ALB | All traffic passes through the ALB |
| CloudFront origin | ALB only, `/static/*` cached | One origin is simpler |
| Domain | notes.example.com (placeholder) | No deployment, so no real domain needed |
| Network | 10.0.0.0/16, six /24 subnets | Room to grow, easy to read |
| Scaling | Target tracking on CPU + step scaling | Normal scaling plus fast reaction to spikes |
| Sessions | Stateless | Any instance can serve any request |
| Instance access | Session Manager | No open ports, no SSH keys, no bastion host |

## Deployment overview

The architecture can be built from the AWS console in this order. Each step depends on the ones before it.

1. **Network:** create the VPC, the six subnets, the Internet Gateway, one NAT Gateway per AZ, and the route tables.
2. **Security groups and network ACL:** create alb-sg, app-sg and db-sg, and the data-subnet network ACL.
3. **Database:** create a DB subnet group with the two data subnets, then an RDS for PostgreSQL Multi-AZ instance with encryption enabled. Run `app/schema.sql` once.
4. **Secrets:** store the database settings in Parameter Store under `/notes-app/`, with the password as a `SecureString`.
5. **IAM role:** create the instance role with `AmazonSSMManagedInstanceCore` and read access to `/notes-app/*`.
6. **Launch template:** choose the AMI and instance type, attach app-sg and the IAM role, require IMDSv2, and add user data that installs Node.js, copies the app and starts `notes-app.service`.
7. **Certificates:** request an ACM certificate for the ALB in eu-central-1, and one for CloudFront in us-east-1.
8. **Load balancer:** create the target group (port 3000, health check `/healthz`), then the internet-facing ALB in the two public subnets with an HTTPS listener and the custom-header rule.
9. **Auto Scaling group:** create it from the launch template in the two app subnets, attach the target group, and add the two scaling policies.
10. **AWS WAF:** create the web ACL with the managed rule groups and the rate-based rule, and attach it to the ALB.
11. **CloudFront:** create the distribution with the ALB as origin, a cached `/static/*` behavior, HTTPS only, and the custom header.
12. **Route 53:** create alias records for `notes.example.com` (to CloudFront) and `origin.example.com` (to the ALB), and the health check.
13. **Monitoring:** create the SNS topic and email subscription, the CloudWatch dashboard, the alarms, and the RDS event subscription.


## Repository structure

```
.
├── README.md
├── app/
│   ├── server.js
│   ├── package.json
│   ├── schema.sql
│   ├── notes-app.service
│   └── public/
│       ├── index.html
│       └── static/
│           ├── app.js
│           └── style.css
└── docs/
    ├── architecture.drawio
    └── architecture.png
```