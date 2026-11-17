// Stand-in for React Native when the app's code runs under plain Node.
export const Platform = { OS: 'web', select: (o) => o.web ?? o.default };
