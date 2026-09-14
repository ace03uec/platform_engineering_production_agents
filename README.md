Platform Engineering For Production Agents
===========================================

The aim of the workshop is to show the attendees the questions that can be raised, when
faced with live production agents and how should one go about debugging them.

The base setup (App)
=====================

This consists of a simple golang app, which has known failure scenarios and includes it's dependencies pgbouncer, postgres and redis. The app also has basic observability and emits metrics, logs and traces to the available setup.

The Pi Incident Management Agent
=================================

We have a simple incident management agent which solves the basic cases for app. 


The Failure Modes and A solution for each mode.
===============================================

1. Liveness and Readiness failures : Is the agent working ? Can the agent continue to accept any more requests ?
2. Observability : The agent was taking some action but isn't responding and we don't know what it's doing any more ?
3. Cost : The agent burned through all my tokens, help ?
4. Safety : The agent deleted my file system, help ?
5. Correctness : Everything ran, but was it right ?

