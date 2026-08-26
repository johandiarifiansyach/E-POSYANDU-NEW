/** Child registry and child-specific read operations. */
export type {
  ChildrenPageRequest,
  ChildrenPageResponse,
  ExclusiveBreastfeedingPageRequest,
  ExclusiveBreastfeedingPageResponse
} from './legacyClient';

export {
  getCachedChildrenPage,
  getChildDetail,
  getChildrenPage,
  getExclusiveBreastfeedingPage,
  peekCachedChildrenPage,
  peekCachedExclusiveBreastfeedingPage
} from './legacyClient';
