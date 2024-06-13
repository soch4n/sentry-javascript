import { SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, getActiveSpan, startInactiveSpan } from '@sentry/browser';
import type { Span } from '@sentry/types';
import { logger, timestampInSeconds } from '@sentry/utils';

import { DEFAULT_HOOKS } from './constants';
import { DEBUG_BUILD } from './debug-build';
import type { Hook, Mixins, Operation, TracingOptions, ViewModel } from './types';
import { formatComponentName } from './vendor/components';

const VUE_OP = 'ui.vue';

type DataSentry = {
  _sentrySpans?: {
    [key: string]: Span | undefined;
  };
  _sentryRootSpan?: Span;
  _sentryRootSpanTimer?: ReturnType<typeof setTimeout>;
};

interface VueSentry extends ViewModel {
  readonly $root: VueSentry;
  $data: DataSentry;
}

// Mappings from operation to corresponding lifecycle hook.
const HOOKS: { [key in Operation]: Hook[] } = {
  activate: ['activated', 'deactivated'],
  create: ['beforeCreate', 'created'],
  // Vue 3
  unmount: ['beforeUnmount', 'unmounted'],
  // Vue 2
  destroy: ['beforeDestroy', 'destroyed'],
  mount: ['beforeMount', 'mounted'],
  update: ['beforeUpdate', 'updated'],
};

/** Finish top-level span and activity with a debounce configured using `timeout` option */
function finishRootSpan(vm: VueSentry, timestamp: number, timeout: number): void {
  if (vm.$data._sentryRootSpanTimer) {
    clearTimeout(vm.$data._sentryRootSpanTimer);
  }

  vm.$data._sentryRootSpanTimer = setTimeout(() => {
    if (vm.$root.$data._sentryRootSpan) {
      vm.$root.$data._sentryRootSpan.end(timestamp);
      vm.$root.$data._sentryRootSpan = undefined;
    }
  }, timeout);
}

export const createTracingMixins = (options: TracingOptions): Mixins => {
  const hooks = (options.hooks || [])
    .concat(DEFAULT_HOOKS)
    // Removing potential duplicates
    .filter((value, index, self) => self.indexOf(value) === index);

  const mixins: Mixins = {
    data: () => ({
      _sentrySpans: undefined,
      _sentryRootSpan: undefined,
      _sentryRootSpanTimer: undefined,
    }),
  };

  for (const operation of hooks) {
    // Retrieve corresponding hooks from Vue lifecycle.
    // eg. mount => ['beforeMount', 'mounted']
    const internalHooks = HOOKS[operation];
    if (!internalHooks) {
      DEBUG_BUILD && logger.warn(`Unknown hook: ${operation}`);
      continue;
    }

    for (const internalHook of internalHooks) {
      mixins[internalHook] = function (this: VueSentry) {
        const isRoot = this.$root === this;

        if (isRoot) {
          const activeSpan = getActiveSpan();
          if (activeSpan) {
            this.$data._sentryRootSpan =
              this.$data._sentryRootSpan ||
              startInactiveSpan({
                name: 'Application Render',
                op: `${VUE_OP}.render`,
                attributes: {
                  [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.ui.vue',
                },
              });
          }
        }

        // Skip components that we don't want to track to minimize the noise and give a more granular control to the user
        const name = formatComponentName(this, false);
        const shouldTrack = Array.isArray(options.trackComponents)
          ? options.trackComponents.indexOf(name) > -1
          : options.trackComponents;

        // We always want to track root component
        if (!isRoot && !shouldTrack) {
          return;
        }

        this.$data._sentrySpans = this.$data._sentrySpans || {};

        // Start a new span if current hook is a 'before' hook.
        // Otherwise, retrieve the current span and finish it.
        if (internalHook == internalHooks[0]) {
          const activeSpan = (this.$root && this.$root.$data._sentryRootSpan) || getActiveSpan();
          if (activeSpan) {
            // Cancel old span for this hook operation in case it didn't get cleaned up. We're not actually sure if it
            // will ever be the case that cleanup hooks re not called, but we had users report that spans didn't get
            // finished so we finish the span before starting a new one, just to be sure.
            const oldSpan = this.$data._sentrySpans[operation];
            if (oldSpan) {
              oldSpan.end();
            }

            this.$data._sentrySpans[operation] = startInactiveSpan({
              name: `Vue <${name}>`,
              op: `${VUE_OP}.${operation}`,
              attributes: {
                [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.ui.vue',
              },
            });
          }
        } else {
          // The span should already be added via the first handler call (in the 'before' hook)
          const span = this.$data._sentrySpans[operation];
          // The before hook did not start the tracking span, so the span was not added.
          // This is probably because it happened before there is an active transaction
          if (!span) return;
          span.end();

          finishRootSpan(this, timestampInSeconds(), options.timeout);
        }
      };
    }
  }

  return mixins;
};
