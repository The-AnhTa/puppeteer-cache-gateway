export const POWERHUB_ORIGIN =
  'https://powerhub.energy.tesla.com';

export const POWERHUB_GROUP_ID =
  '39bb89eb-40df-4357-a8b3-a4c112e110c6';

const groupPath =
  `/group/${POWERHUB_GROUP_ID}`;

export const POWERHUB_ROUTES = Object.freeze([
  Object.freeze({
    key: 'overview',
    label: 'Overview',
    path: groupPath,
    url: `${POWERHUB_ORIGIN}${groupPath}`
  }),
  Object.freeze({
    key: 'map',
    label: 'Map',
    path: `${groupPath}/map`,
    url: `${POWERHUB_ORIGIN}${groupPath}/map`
  }),
  Object.freeze({
    key: 'sites',
    label: 'Sites and Groups',
    path: `${groupPath}/sites`,
    url: `${POWERHUB_ORIGIN}${groupPath}/sites`
  }),
  Object.freeze({
    key: 'alerts',
    label: 'Alerts',
    path: `${groupPath}/alerts`,
    url: `${POWERHUB_ORIGIN}${groupPath}/alerts`
  }),
  Object.freeze({
    key: 'graphing',
    label: 'Graphing',
    path: `${groupPath}/graph-v2`,
    url: `${POWERHUB_ORIGIN}${groupPath}/graph-v2`
  })
]);

const allowedUrls =
  new Set(
    POWERHUB_ROUTES.map(
      route => route.url
    )
  );

export function assertAllowedNavigation(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'DENIED: navigation URL is invalid'
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.origin !== POWERHUB_ORIGIN ||
    !allowedUrls.has(parsed.href)
  ) {
    throw new Error(
      'DENIED: navigation is not an exact allowlisted Powerhub route'
    );
  }

  return parsed.href;
}

export function assertCapturedLocation(
  value,
  expectedRoute
) {
  const allowed =
    assertAllowedNavigation(value);

  if (allowed !== expectedRoute.url) {
    throw new Error(
      `DENIED: expected ${expectedRoute.label} route after navigation`
    );
  }

  return allowed;
}
