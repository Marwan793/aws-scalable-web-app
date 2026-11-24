# Scalable Web Application on AWS with ALB, Auto Scaling and Multi-AZ RDS

A highly available and secure web application on AWS that scales automatically with traffic.

> Graduation project for Manara’s “AWS 2: Becoming a Solutions Architect” course. This repository documents the architecture; an Infrastructure as Code implementation is planned (see [Limitations and future work](#limitations-and-future-work)).

## Table of contents

- [Solution overview](#solution-overview)
- [Architecture diagram](#architecture-diagram)
- [Request flow](#request-flow)
- [AWS services and why each was chosen](#aws-services-and-why-each-was-chosen)
- [Network design](#network-design)
- [Security](#security)
- [High availability and failure scenarios](#high-availability-and-failure-scenarios)
- [Scaling](#scaling)
- [Monitoring and alerting](#monitoring-and-alerting)
- [Design decisions](#design-decisions)
- [Deployment overview](#deployment-overview)
- [Limitations and future work](#limitations-and-future-work)
- [Repository structure](#repository-structure)
- [Author](#author)

## Solution overview

A web application must stay available when a server or a whole Availability Zone fails, stay fast when traffic grows, and keep its servers and data away from direct internet access. Running the application on a single server meets none of these needs: one failure stops the service, and extra traffic slows it down.

This solution runs the application on Amazon EC2 instances in private subnets across two Availability Zones in eu-central-1 (Frankfurt). An Auto Scaling group adds or removes instances as load changes and replaces unhealthy ones. User traffic reaches the instances only through Amazon CloudFront, which caches static files at edge locations, and an Application Load Balancer protected by AWS WAF. Data is stored in Amazon RDS for PostgreSQL with a Multi-AZ standby, so the database fails over automatically if the primary fails. Administrators reach the instances through AWS Systems Manager Session Manager, without SSH keys, open inbound ports or a bastion host.

The example workload is a simple Notes application (Node.js and PostgreSQL) in the [app/](app/) folder: a single page, static files under `/static/*`, and a small REST API under `/api/notes`. The application is stateless, so any instance can serve any request. This repository documents the architecture; an Infrastructure as Code implementation is planned (see [Limitations and future work](#limitations-and-future-work)).

## Architecture diagram

![Architecture diagram](docs/architecture.png)

<!-- Editable source: docs/architecture.drawio -->

## Request flow

The numbers below match the numbered arrows in the architecture diagram.

1. DNS lookup: the browser asks Route 53 for the address of `notes.example.com`. Route 53 returns the address of the      
nearest CloudFront edge location. It only answers the DNS query; the request itself does not pass through it.
2. HTTPS to CloudFront: the browser sends the request to the edge location.
   - Requests for `/static/*` (CSS and JavaScript) are answered from the CloudFront cache. If the file is not in the cache yet, CloudFront gets it from the ALB once and keeps a copy.
   - All other requests (`/` and `/api/*`) are not cached and go to step 3.
3. CloudFront to the ALB: CloudFront forwards the request to the ALB through the Internet Gateway, with a secret custom header. Before the request is routed, it passes three checks:
   - The ALB security group accepts traffic only from CloudFront.
   - AWS WAF blocks common attacks such as SQL injection and cross-site scripting.
   - An ALB listener rule rejects requests without the custom header.
4. ALB to EC2: the ALB sends the request to a healthy instance in either Availability Zone.
5. EC2 to RDS: for `/api/notes`, the application reads from or writes to the RDS primary database. For `/` and `/static/*`, it returns the file directly, without the database.
6. Response: the response goes back the same way to the browser.

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

<!-- Explain why the data subnets have no internet route. -->

## Security

### Layers of defense

<!-- From the edge inward: CloudFront → WAF → ALB security group → app security group → DB security group, plus NACLs, IAM and encryption. -->

### Security group chain

| Security group | Inbound rule | Source |
| --- | --- | --- |
| alb-sg | TBD | TBD |
| app-sg | TBD | alb-sg |
| db-sg | TBD | app-sg |

### Network ACLs

<!-- Which subnets, which rules, and why NACLs are stateless. -->

### AWS WAF rules

<!-- Managed rule groups (OWASP Top 10), rate-based rule, web ACL attached to the ALB. -->

### Instance access and permissions

<!-- Session Manager instead of SSH or a bastion host. Instance IAM role. IMDSv2. -->

### Encryption

<!-- In transit (TLS at CloudFront, ALB and RDS) and at rest (RDS, EBS with KMS). -->

## High availability and failure scenarios

| Failure | What happens | Recovery time | User impact |
| --- | --- | --- | --- |
| One EC2 instance fails | TBD | TBD | TBD |
| Application process crashes, instance still running | TBD | TBD | TBD |
| An entire Availability Zone fails | TBD | TBD | TBD |
| RDS primary fails | TBD | TBD | TBD |
| One NAT Gateway fails | TBD | TBD | TBD |
| Traffic spike | TBD | TBD | TBD |

## Scaling

<!-- Target tracking on CPU + step scaling, min / desired / max, warmup, health checks, stateless app. -->

## Monitoring and alerting

### Dashboard

<!-- Which widgets and why. -->

### Alarms

| Alarm | Metric | Threshold | Action |
| --- | --- | --- | --- |
| TBD | TBD | TBD | SNS email |

## Design decisions

| Decision | Chosen option | Alternatives considered | Reason |
| --- | --- | --- | --- |
| Application | Simple Notes app (Node.js + PostgreSQL) | TBD | TBD |
| Tiers | One app tier behind the ALB | TBD | TBD |
| Database engine | RDS for PostgreSQL, Multi-AZ | TBD | TBD |
| Region | eu-central-1 (Frankfurt) | TBD | TBD |
| NAT Gateways | One per AZ | TBD | TBD |
| WAF placement | Web ACL on the ALB | TBD | TBD |
| CloudFront origin | ALB only, /static/* cached | TBD | TBD |
| Domain | notes.example.com (placeholder) | TBD | TBD |
| Network plan | 10.0.0.0/16, six /24 subnets | TBD | TBD |
| Scaling | Target tracking on CPU + step scaling | TBD | TBD |
| Session state | Stateless | TBD | TBD |
| Instance access | Session Manager through NAT | TBD | TBD |

## Deployment overview

<!-- Ordered console steps to build the solution. -->

## Limitations and future work

- Implement the full architecture as Infrastructure as Code.
- <!-- VPC interface endpoints for Systems Manager instead of NAT -->

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
