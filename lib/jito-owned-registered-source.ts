import 'server-only';

// Keep the issued-handle WeakMap in one server-only module. No signed bytes or
// accessors for internal evidence are exported by this compatibility facade.
export {
  captureOwnedRegisteredJitoSource,
  recheckOwnedRegisteredJitoSource,
} from './jito-owned-registered-source-internal';
