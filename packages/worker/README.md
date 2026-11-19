# @harness/worker

Background task worker powered by Redis and BullMQ.

Hard rule: Redis/BullMQ is used only for job dispatching; PostgreSQL remains the source of truth for state.
